'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as core from './core';

export function activate(context: vscode.ExtensionContext) {
    new core.Context(context);
}

export function deactivate() {
}