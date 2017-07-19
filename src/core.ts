'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as process from "child_process";

const PACKAGE_NAME_PATTERN = '[\\w]+';
const NPM_PACKAGE_NAME = 'package.json';
const PACKAGES_NOT_EXISTS = new Set();

abstract class PackageManager {
    protected existsPackageNames: Set<string> = null;

    abstract installAsync(packageName: string) : Promise<any>;
    abstract getName();
    abstract existsAsync(packageName: string) : Promise<boolean>;

    _internalInstallAsync(packageName: string, command: string, cwd = null) : Promise<any> {
        return new Promise((resolve, reject) => {
            process.exec(command, { cwd : cwd }, (error, stdout, stderr) => {
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
                    reject();
                } else {
                    resolve();
                }
            });
        });

    }

    _internalExistsAsync(packageName: string, command: string, options: any) : Promise<boolean> {
        let self = this;
        return new Promise<boolean>((resolve, reject) => {
            if (self.existsPackageNames !== null) {
                resolve(self.existsPackageNames.has(packageName));
            }

            process.exec(command, options, (error, stdout, stderr) => {
                if (self.existsPackageNames === null) {
                    self.existsPackageNames = new Set<string>();

                    if (error) {
                        console.log(error);
                        console.log(stdout);
                        console.log(stderr);
                    } else {
                        let lines = stdout.split('\n');
                        let regex = new RegExp(`@types[\/\\\\](${PACKAGE_NAME_PATTERN})@.+$`);
                        lines.forEach(z => {
                            let m = z.match(regex);
                            if (m) {
                                self.existsPackageNames.add(m[1]);
                            }
                        })
                    }
                }
                resolve(self.existsPackageNames.has(packageName));
            });
        });
    }
}

class GlobalPackageManager extends PackageManager {
    getName() {
        return 'global';
    }

    existsAsync(packageName: string) : Promise<boolean> {
        return this._internalExistsAsync(packageName, 'npm list -g --depth=0', {});
    }

    installAsync(packageName: string) : Promise<any> {
        //let command = `npm xxxxx`;
        let command = `npm install -g @types/${packageName} `;
        return this._internalInstallAsync(packageName, command);
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

    existsAsync(packageName: string) : Promise<boolean> {
        return this._internalExistsAsync(packageName, 'npm list --depth=0', { cwd: this.workDir });
    }

    installAsync(packageName: string) : Promise<any> {
        //let command = `npm xxxxx`;
        let command = `npm install -save-dev @types/${packageName} `;
        return this._internalInstallAsync(packageName, command, this.workDir);
    }
}


export class Context {
    private extensionContext: vscode.ExtensionContext;
    private globalPackageManager: PackageManager = new GlobalPackageManager();
    private localPackageManager: PackageManager = null;
    private packageExists: boolean = false; // become null when 'package.json' is not exists.
    private outputChanel: vscode.OutputChannel = null;

    constructor (context: vscode.ExtensionContext) {
        console.log('fdfdfd');
        let self = this;
        this.extensionContext = context;

        if (vscode.workspace.rootPath) {
            this.localPackageManager = new LocalPackageManager(vscode.workspace.rootPath);
            vscode.workspace.findFiles(NPM_PACKAGE_NAME).then(z => {
                self.packageExists = z.length > 0;
            });

            let watcher = vscode.workspace.createFileSystemWatcher(
                vscode.workspace.rootPath + '/' + NPM_PACKAGE_NAME, false, true, false);
            context.subscriptions.push(watcher.onDidCreate(z => {
                self.packageExists = true;
            }));
            context.subscriptions.push(watcher.onDidDelete(z => {
                self.packageExists = false;
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

        this.localPackageManager.existsAsync('');
        this.globalPackageManager.existsAsync('');
    }

    async onLineCompleted(content: string) {
        let packageName = this.tryParsePackageName(content);
        if (packageName !== null) {
            if (PACKAGES_NOT_EXISTS.has(packageName)) {
                return;
            }

            if (this.outputChanel === null) {
                this.outputChanel = vscode.window.createOutputChannel("Quiet-Types");
                this.extensionContext.subscriptions.push(this.outputChanel);
            }

            if (this.localPackageManager !== null && await this.localPackageManager.existsAsync(packageName)) {
                this.outputChanel.appendLine(`@types/${packageName}> already exists in ${this.localPackageManager.getName()}.`);
                return;
            } else if (await this.globalPackageManager.existsAsync(packageName)) {
                this.outputChanel.appendLine(`@types/<${packageName}> already exists in ${this.globalPackageManager.getName()}.`);
                return;
            }

            let packageManager = this.getPackageManager();
            if (packageManager) {
                this.outputChanel.appendLine(`Installing @types/<${packageName}> to ${packageManager.getName()}.`);
                try {
                    await packageManager.installAsync(packageName);
                    this.outputChanel.appendLine(`@types/<${packageName}> Installed.`);
                } catch (err) {
                    this.outputChanel.appendLine(`@types/<${packageName}> install occur error.`);
                }
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
                return this.packageExists ? this.localPackageManager : this.globalPackageManager;
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

        let match = content.match(new RegExp(`require\\('(${PACKAGE_NAME_PATTERN})'\\);?$`)) ||
                    content.match(new RegExp(`require\\("(${PACKAGE_NAME_PATTERN})"\\);?$`));
        if (match) {
            try {
                eval(match[0]);
                return packageName;
            } catch (_) { }
        }

        // e.g.
        // import * as vscode from 'vscode';
        // import { LogLevel, ILogger, Logger } from './utils/logger';

        match = content.match(new RegExp(`^import .+ from '(${PACKAGE_NAME_PATTERN})';?$`)) ||
                content.match(new RegExp(`^import .+ from "(${PACKAGE_NAME_PATTERN})";?$`));
        if (match) {
            return match[1];
        }

        return null;
    }
}



