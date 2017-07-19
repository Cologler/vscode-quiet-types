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
    private _loadExistsPackageNamesPromise: Promise<any> = null;

    abstract installAsync(packageName: string) : Promise<any>;
    abstract getName();
    abstract BeginLoadPackages();

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
                    this.existsPackageNames.add(packageName);
                    resolve();
                }
            });
        });
    }

    _internalBeginLoadPackages(command: string, options: any) {
        let self = this;
        this._loadExistsPackageNamesPromise = new Promise((resolve, reject) => {
            process.exec(command, options, (error, stdout, stderr) => {
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
                resolve();
            });
        });
    }

    async isExistsAsync(packageName: string) {
        if (this.existsPackageNames === null) {
            await this._loadExistsPackageNamesPromise;
        }
        return this.existsPackageNames.has(packageName);
    }
}

class GlobalPackageManager extends PackageManager {
    getName() {
        return 'Global';
    }

    installAsync(packageName: string) : Promise<any> {
        //let command = `npm xxxxx`;
        let command = `npm install -g @types/${packageName} `;
        return this._internalInstallAsync(packageName, command);
    }

    BeginLoadPackages() {
        this._internalBeginLoadPackages('npm list -g --depth=0', {});
    }
}

class LocalPackageManager extends PackageManager {
    private workDir: string;

    constructor (workDir: string) {
        super();
        this.workDir = workDir;
    }

    getName() {
        return 'Workspace';
    }

    installAsync(packageName: string) : Promise<any> {
        //let command = `npm xxxxx`;
        let command = `npm install -save-dev @types/${packageName} `;
        return this._internalInstallAsync(packageName, command, this.workDir);
    }

    BeginLoadPackages() {
        this._internalBeginLoadPackages('npm list --depth=0', { cwd: this.workDir });
    }
}


export class Context {
    private extensionContext: vscode.ExtensionContext;
    private globalPackageManager: PackageManager = new GlobalPackageManager();
    private localPackageManager: PackageManager = null;
    private packageExists: boolean = false; // become null when 'package.json' is not exists.
    private outputChanel: vscode.OutputChannel = null;

    constructor (context: vscode.ExtensionContext) {
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

        this.localPackageManager.BeginLoadPackages();
        this.globalPackageManager.BeginLoadPackages();
        console.log('end init.');
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
            let output = this.outputChanel;

            async function checkExistsAsync(packageManager: PackageManager) {
                if (packageManager !== null && await packageManager.isExistsAsync(packageName)) {
                    output.appendLine(`${packageManager.getName()}: @types/${packageName}> already installed.`);
                    return true;
                }
                return false;
            }

            if (await checkExistsAsync(this.localPackageManager) || await checkExistsAsync(this.globalPackageManager)) {
                return;
            }

            let packageManager = this.getPackageManager();
            if (packageManager) {
                let disposable = vscode.window.setStatusBarMessage(
                    `Installing @types/<${packageName}> to ${packageManager.getName()}.`, 10000
                );
                this.extensionContext.subscriptions.push(disposable);

                try {
                    await packageManager.installAsync(packageName);
                    output.appendLine(`${packageManager.getName()}: @types/<${packageName}> installed.`);
                } catch (err) {
                    output.appendLine(`${packageManager.getName()}: @types/<${packageName}> install occur error.`);
                }
                disposable.dispose();
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



