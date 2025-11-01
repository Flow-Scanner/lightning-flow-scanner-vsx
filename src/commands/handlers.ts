import * as vscode from 'vscode';
import { SelectFlows } from '../libs/SelectFlows';
import { SaveFlow } from '../libs/SaveFlow';
import { ScanOverview } from '../panels/ScanOverviewPanel';
import * as core from 'lightning-flow-scanner-core';
import { CacheProvider } from '../providers/cache-provider';
import { OutputChannel } from '../providers/outputChannel';
import { ConfigProvider } from '../providers/config-provider';
import * as YAML from 'yaml';

const toFsPaths = (uris: vscode.Uri[]): string[] => uris.map(u => u.fsPath);
const toUris = (paths: string[]): vscode.Uri[] => paths.map(p => vscode.Uri.file(p));

export default class Commands {
  constructor(private context: vscode.ExtensionContext) {}

  get handlers() {
    const rawHandlers: Record<string, (...args: any[]) => any> = {
      'flowscanner.openDocumentation': () => this.openDocumentation(),
      'flowscanner.configRules': () => this.configRules(),
      'flowscanner.scanFlows': () => this.scanFlows(),
      'flowscanner.fixFlows': () => this.fixFlows(),
    };
    return Object.entries(rawHandlers).map(([command, handler]) => {
      return [
        command,
        async (...args: any[]): Promise<any> => {
          return handler(...args);
        },
      ] as const;
    });
  }

  private openDocumentation() {
    const url = vscode.Uri.parse('https://github.com/Flow-Scanner/lightning-flow-scanner-core?tab=readme-ov-file#default-rules');
    vscode.env.openExternal(url);
  }

  private async configRules() {
    type RuleWithExpression = { severity: string; expression?: string };
    type RuleConfig = Record<string, RuleWithExpression>;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder found.');
      return;
    }
    const workspacePath = workspaceFolders[0].uri.fsPath;
    const configProvider = new ConfigProvider();
    try {
      const configResult = await configProvider.discover(workspacePath);
      const configTyped = configResult.config as { rules?: RuleConfig } | undefined;
      const rules: RuleConfig = configTyped?.rules ?? {};
      if (!rules.FlowName?.expression) {
        const naming = await vscode.window.showInputBox({
          prompt: 'Define a naming convention for Flow Names (REGEX format).',
          placeHolder: '[A-Za-z0-9]+_[A-Za-z0-9]+',
          value: '[A-Za-z0-9]+_[A-Za-z0-9]+',
        });
        if (naming) rules.FlowName = { severity: 'error', expression: naming };
      }
      if (!rules.APIVersion?.expression) {
        const apiVersion = await vscode.window.showInputBox({
          prompt: 'Set an API Version rule (e.g. ">50" or ">=60").',
          placeHolder: '>50',
          value: '>50',
        });
        if (apiVersion) rules.APIVersion = { severity: 'error', expression: apiVersion };
      }
      const yamlString = YAML.stringify(configResult.config);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(configResult.fspath),
        new TextEncoder().encode(yamlString)
      );
      await CacheProvider.instance.set('ruleconfig', rules);
      OutputChannel.getInstance().logChannel.debug('Stored YAML rule config', rules);
      const document = await vscode.workspace.openTextDocument(configResult.fspath);
      await vscode.window.showTextDocument(document);
      vscode.window.showInformationMessage(`Loaded configuration from ${configResult.fspath}`);
      return;
    } catch (err: any) {
      vscode.window.showErrorMessage(`Error loading configuration: ${err?.message || err}`);
      return;
    }
  }

  private async scanFlows() {
    const selectedUris = await this.selectFlows('Select flow files or folder to scan:');
    if (!selectedUris) return;
    const rootPath = vscode.workspace.workspaceFolders![0].uri;
    let results: core.ScanResult[] = [];
    ScanOverview.createOrShow(this.context.extensionUri, results);
    OutputChannel.getInstance().logChannel.trace('Created scan overview panel');
    const configReset = vscode.workspace.getConfiguration('flowscanner').get<boolean>('Reset');
    if (configReset) {
      OutputChannel.getInstance().logChannel.trace('Resetting configurations');
      await this.configRules();
    }
    const configProvider = new ConfigProvider();
    const ruleConfig = await configProvider.loadConfig(rootPath.fsPath);
    OutputChannel.getInstance().logChannel.debug('Loaded rule config', ruleConfig);
    const parsedFlows = await core.parse(toFsPaths(selectedUris));
    results = core.scan(parsedFlows, ruleConfig);
    OutputChannel.getInstance().logChannel.debug('Scan completed', results.length, 'results');
    await CacheProvider.instance.set('results', results);
    ScanOverview.createOrShow(this.context.extensionUri, results);
  }

  private async fixFlows() {
    let results: core.ScanResult[] = CacheProvider.instance.get('results') || [];
    if (results.length > 0) {
      const useCached = await vscode.window.showQuickPick(
        ['Use last scan results', 'Select different files to fix'],
        { placeHolder: `Found ${results.length} scan result(s) from previous run` }
      );
      if (useCached === 'Select different files to fix') {
        results = [];
      } else if (useCached === undefined) {
        return;
      }
    }
    if (results.length === 0) {
      const selectedUris = await this.selectFlows('Select flow files to fix:');
      if (!selectedUris) return;
      const rootPath = vscode.workspace.workspaceFolders![0].uri;
      const configProvider = new ConfigProvider();
      const ruleConfig = await configProvider.loadConfig(rootPath.fsPath);
      const parsedFlows = await core.parse(toFsPaths(selectedUris));
      results = core.scan(parsedFlows, ruleConfig);
      OutputChannel.getInstance().logChannel.debug('Re-scanned for fix', results.length);
    }
    if (results.length === 0) {
      vscode.window.showInformationMessage('No issues to fix.');
      ScanOverview.createOrShow(this.context.extensionUri, []);
      return;
    }
    ScanOverview.createOrShow(this.context.extensionUri, results);
    const newResults = core.fix(results);
    OutputChannel.getInstance().logChannel.debug('Fix applied', newResults.length, 'updated');
    for (const result of newResults) {
      const uri = vscode.Uri.file(result.flow.fsPath);
      await new SaveFlow().execute(result.flow, uri);
      OutputChannel.getInstance().logChannel.trace('Fixed & saved', uri.fsPath);
    }
    await CacheProvider.instance.set('results', newResults);
    if (newResults.length > 0) {
      ScanOverview.createOrShow(this.context.extensionUri, newResults);
    } else {
      vscode.window.showWarningMessage(
        'Fix Flows: Only UnusedVariable and UnconnectedElement rules are supported.'
      );
      ScanOverview.createOrShow(this.context.extensionUri, results);
    }
  }

  private async selectFlows(prompt: string): Promise<vscode.Uri[] | undefined> {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!rootPath) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return undefined;
    }
    const selectedPaths = await new SelectFlows(rootPath, prompt).execute(rootPath);
    OutputChannel.getInstance().logChannel.debug('Selected paths', ...selectedPaths);
    if (selectedPaths.length === 0) {
      vscode.window.showInformationMessage('No flow files selected.');
      return undefined;
    }
    return toUris(selectedPaths);
  }
}