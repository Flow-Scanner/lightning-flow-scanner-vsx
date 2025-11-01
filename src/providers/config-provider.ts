import {
  IRulesConfig,
  getRules,
  AdvancedRule,
} from 'lightning-flow-scanner-core';
import * as vscode from 'vscode';
import { Document, parse } from 'yaml';

type Configuration = {
  fspath: string;
  config: unknown;
};

export class ConfigProvider {
  public async discover(configPath: string): Promise<Configuration> {
    const configurationName = 'flow-scanner';
    const findInJson = [`.${configurationName}.json`, `${configurationName}.json`];
    const findInYml = [
      `.${configurationName}.yml`,
      `.${configurationName}.yaml`,
      `${configurationName}.yaml`,
      `${configurationName}.yml`,
      configurationName,
    ];

    let configFile =
      (await this.attemptToReadConfig(configPath, findInJson, JSON.parse)) ??
      (await this.attemptToReadConfig(configPath, findInYml, parse));

    return configFile;
  }

  private async attemptToReadConfig(
    basePath: string,
    potentialFileNames: string[],
    parser: Function
  ): Promise<Configuration | null> {
    for (const fileName of potentialFileNames) {
      const file = vscode.Uri.file(`${basePath}/${fileName}`);
      try {
        await vscode.workspace.fs.stat(file);
        const fileContent = Buffer.from(await vscode.workspace.fs.readFile(file)).toString();
        const config = parser(fileContent);
        return { fspath: file.fsPath, config };
      } catch {}
    }
    return null;
  }

  public async loadConfig(configPath?: string): Promise<IRulesConfig> {
    const explorerResults = await this.discover(configPath || vscode.workspace.workspaceFolders![0].uri.fsPath);
    return (explorerResults?.config as IRulesConfig) ?? { rules: {} };
  }
}