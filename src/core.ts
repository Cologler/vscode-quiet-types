'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as process from "child_process";

const NPM_PACKAGE_NAME = 'package.json';
const PACKAGES_NOT_EXISTS = new Set();

abstract class PackageManager {
    abstract install(packageName: string);
    abstract getName();

    internalExecNpmCommand(packageName: string, command: string, cwd = null) {
        let p = process.exec(command, { cwd : cwd }, (error, stdout, stderr) => {
            if (error) {
                if (stderr) {
                    if (stderr.startsWith('npm ERR! code E404')) {
                        PACKAGES_NOT_EXISTS.add(packageName);
                        return;
                    }
                }

                console.log(error);
                console.log(stdout);
                console.log(stderr);
            }
            p.disconnect();
        });
    }
}

class GlobalPackageManager extends PackageManager {
    getName() {
        return 'global';
    }

    install(packageName: string) {
        //let command = `npm xxxxx`;
        let command = `npm install -g @types/${packageName} `;
        this.internalExecNpmCommand(packageName, command);
    }
}

class LocalPackageManager extends PackageManager {
    private workDir: string;

    constructor (workDir: string) {
        super();
        this.workDir = workDir;
    }

    getName() {
        return 'workspace';
    }

    install(packageName: string) {
        //let command = `npm xxxxx`;
        let command = `npm install -save-dev @types/${packageName} `;
        this.internalExecNpmCommand(packageName, command, this.workDir);
    }
}


export class Context {
    private extensionContext: vscode.ExtensionContext;
    private globalPackageManager: PackageManager = new GlobalPackageManager();
    private localPackageManager: PackageManager = null;
    private dynamicLocalPackageManager: PackageManager = null; // become null when 'package.json' is not exists.
    private outputChanel: vscode.OutputChannel = null;

    constructor (context: vscode.ExtensionContext) {
        console.log('xxxxxxxxxx');
        let self = this;
        this.extensionContext = context;

        if (vscode.workspace.rootPath) {
            this.localPackageManager = new LocalPackageManager(vscode.workspace.rootPath);
            vscode.workspace.findFiles(NPM_PACKAGE_NAME).then(z => {
                if (z.length > 0) {
                    self.dynamicLocalPackageManager = self.localPackageManager;
                }
            });

            let watcher = vscode.workspace.createFileSystemWatcher(
                vscode.workspace.rootPath + '/' + NPM_PACKAGE_NAME, false, true, false);
            context.subscriptions.push(watcher.onDidCreate(z => {
                self.dynamicLocalPackageManager = self.localPackageManager;
            }));
            context.subscriptions.push(watcher.onDidDelete(z => {
                self.dynamicLocalPackageManager = null;
            }));
            context.subscriptions.push(watcher);
        }

        let lastDocument: vscode.TextDocument = null;
        let lastLineNumber: number = null;
        context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(e => {
            let line = e.textEditor.document.lineAt(e.textEditor.selection.end);
            if (lastDocument === null || lastLineNumber === null) {
                lastDocument = e.textEditor.document;
                lastLineNumber = line.lineNumber;
            } else if (lastDocument !== e.textEditor.document || lastLineNumber !== line.lineNumber) {
                let lastLine = e.textEditor.document.lineAt(lastLineNumber);
                let content = e.textEditor.document.getText(lastLine.range);
                self.onLineCompleted(content);
                lastDocument = e.textEditor.document;
                lastLineNumber = line.lineNumber;
            }
        }));
    }

    async onLineCompleted(content: string) {
        let packageName = this.tryParsePackageName(content);
        if (packageName !== null) {
            if (PACKAGES_NOT_EXISTS.has(packageName)) {
                return;
            }
            let packageManager = this.getPackageManager();
            if (packageManager) {
                if (this.outputChanel === null) {
                    this.outputChanel = vscode.window.createOutputChannel(
                        "Quiet-Types"
                    );
                    this.extensionContext.subscriptions.push(this.outputChanel);
                }
                this.outputChanel.appendLine(`Installing <${packageName}> to ${packageManager.getName()}.`)
                packageManager.install(packageName);
            }
        }
    }

    getPackageManager() {
        let configuration = vscode.workspace.getConfiguration('quiet-types');
        let target = configuration.get<string>('target');
        switch (target) {
            case "global":
                return this.globalPackageManager;
            case "workspace":
                return this.localPackageManager;
            case "auto":
                return this.dynamicLocalPackageManager || this.globalPackageManager;
            default:
                return this.localPackageManager;
        }
    }

    tryParsePackageName(content: string) {
        // e.g. require(xxx);
        let packageName = null;
        function require(name) {
            packageName = name;
        }

        const packageNamePattern = '[\\w]+';
        let match = content.match(new RegExp(`require\\('(${packageNamePattern})'\\);?$`)) ||
                    content.match(new RegExp(`require\\("(${packageNamePattern})"\\);?$`));
        if (match) {
            try {
                eval(match[0]);
                return packageName;
            } catch (_) { }
        }

        // e.g.
        // import * as vscode from 'vscode';
        // import { LogLevel, ILogger, Logger } from './utils/logger';

        match = content.match(new RegExp(`^import .+ from '(${packageNamePattern})';?$`)) ||
                content.match(new RegExp(`^import .+ from "(${packageNamePattern})";?$`));
        if (match) {
            return match[1];
        }

        return null;
    }
}



