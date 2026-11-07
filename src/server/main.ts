/**
 * moro language server entry point: wires the LSP connection to the
 * workspace index and the feature providers.
 */
import { fileURLToPath } from 'node:url';
import {
  CompletionItem,
  DidChangeConfigurationNotification,
  FileChangeType,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  Range,
  TextDocumentSyncKind,
  TextDocuments,
  TextEdit,
  createConnection,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ParseResult, positionAt } from '../common/reader';
import { IndentSettings, defaultSettings as defaultIndentSettings, indentationForLine, reindentLines, OffsetEdit } from './indent';
import { LiveConnectionInfo, LiveImage } from './live';
import * as providers from './providers';
import { lookupStandard } from './symbols';
import { IndexedFile, WorkspaceIndex, bodyArity } from './workspace';

interface MoroSettings {
  indentation: { specs: Record<string, number> };
  indexing: { exclude: string[]; maxFiles: number };
  dependencies: { index: boolean; registries: string[]; maxFiles: number };
  diagnostics: { enabled: boolean };
  hover: { hyperspecUrl: string };
}

function defaultSettings(): MoroSettings {
  return {
    indentation: { specs: {} },
    indexing: {
      exclude: ['**/node_modules/**', '**/.git/**', '**/quicklisp/**', '**/.qlot/**', '**/ocicl/**', '**/.cache/**'],
      maxFiles: 3000,
    },
    dependencies: { index: true, registries: [], maxFiles: 4000 },
    diagnostics: { enabled: true },
    hover: { hyperspecUrl: 'http://www.lispworks.com/documentation/HyperSpec/Body/' },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeSettings(raw: unknown): MoroSettings {
  const settings = defaultSettings();
  if (!isRecord(raw)) return settings;
  const indentation = raw.indentation;
  if (isRecord(indentation) && isRecord(indentation.specs)) {
    settings.indentation.specs = Object.fromEntries(
      Object.entries(indentation.specs).filter(([, v]) => typeof v === 'number' && Number.isInteger(v) && v >= 0) as [string, number][],
    );
  }
  const indexing = raw.indexing;
  if (isRecord(indexing)) {
    if (Array.isArray(indexing.exclude)) settings.indexing.exclude = indexing.exclude.filter((g): g is string => typeof g === 'string');
    if (typeof indexing.maxFiles === 'number') settings.indexing.maxFiles = Math.max(0, Math.floor(indexing.maxFiles));
  }
  const dependencies = raw.dependencies;
  if (isRecord(dependencies)) {
    if (typeof dependencies.index === 'boolean') settings.dependencies.index = dependencies.index;
    if (Array.isArray(dependencies.registries)) settings.dependencies.registries = dependencies.registries.filter((g): g is string => typeof g === 'string');
    if (typeof dependencies.maxFiles === 'number') settings.dependencies.maxFiles = Math.max(0, Math.floor(dependencies.maxFiles));
  }
  const diagnostics = raw.diagnostics;
  if (isRecord(diagnostics) && typeof diagnostics.enabled === 'boolean') settings.diagnostics.enabled = diagnostics.enabled;
  const hover = raw.hover;
  if (isRecord(hover) && typeof hover.hyperspecUrl === 'string' && hover.hyperspecUrl.trim()) settings.hover.hyperspecUrl = hover.hyperspecUrl.trim();
  return settings;
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const index = new WorkspaceIndex();
let settings = defaultSettings();
let workspaceFolders: string[] = [];
let hasConfiguration = false;

const live = new LiveImage();

const ctx: providers.ServerContext = {
  index,
  live,
  get hyperspecBase() {
    return settings.hover.hyperspecUrl;
  },
};

function log(message: string): void {
  connection.console.log(`[moro] ${message}`);
}

live.log = log;
live.onStatus = (status) => void connection.sendNotification('moro/liveStatus', status);

/** The extension tells us where the REPL's backend listens (null when the REPL closed). */
connection.onNotification('moro/liveImage', (params: LiveConnectionInfo | null) => {
  if (params && typeof params.port === 'number' && typeof params.tokenPath === 'string') void live.connect(params);
  else live.disconnect();
});

function folderPath(uri: string): string | null {
  if (!uri.startsWith('file:')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  hasConfiguration = !!params.capabilities.workspace?.configuration;
  workspaceFolders = (params.workspaceFolders ?? []).map((f) => folderPath(f.uri)).filter((p): p is string => !!p);
  if (!workspaceFolders.length && params.rootUri) {
    const root = folderPath(params.rootUri);
    if (root) workspaceFolders = [root];
  }
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: true, triggerCharacters: ['(', ':', '&'] },
      hoverProvider: true,
      signatureHelpProvider: { triggerCharacters: ['(', ' '], retriggerCharacters: [' '] },
      definitionProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      renameProvider: { prepareProvider: true },
      foldingRangeProvider: true,
      selectionRangeProvider: true,
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      documentOnTypeFormattingProvider: { firstTriggerCharacter: '\n' },
      semanticTokensProvider: {
        legend: { tokenTypes: providers.SEMANTIC_TOKEN_TYPES, tokenModifiers: providers.SEMANTIC_TOKEN_MODIFIERS },
        full: true,
        range: false,
      },
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
    },
    serverInfo: { name: 'moro' },
  };
});

async function refreshSettings(): Promise<void> {
  if (hasConfiguration) {
    try {
      settings = mergeSettings(await connection.workspace.getConfiguration('moro'));
    } catch (error) {
      log(`Could not read settings: ${String(error)}`);
    }
  }
  index.settings = { exclude: settings.indexing.exclude, maxFiles: settings.indexing.maxFiles };
  index.dependencySettings = {
    enabled: settings.dependencies.index,
    registries: settings.dependencies.registries,
    maxFiles: settings.dependencies.maxFiles,
  };
}

let dependencyScanTimer: NodeJS.Timeout | undefined;
let dependencyScanRunning: Promise<void> | null = null;

/** Indexes the systems the workspace depends on; serialized, and debounced when triggered by edits. */
function scheduleDependencyScan(delay = 0): void {
  if (dependencyScanTimer) clearTimeout(dependencyScanTimer);
  dependencyScanTimer = setTimeout(() => {
    dependencyScanTimer = undefined;
    const run = async () => {
      try {
        await index.scanDependencies(workspaceFolders, log);
      } catch (error) {
        log(`Dependency scan failed: ${String(error)}`);
      }
    };
    dependencyScanRunning = (dependencyScanRunning ?? Promise.resolve()).then(run);
  }, delay);
}

async function scanWorkspace(folders: string[]): Promise<void> {
  if (!folders.length) return;
  try {
    await index.scanFolders(folders, log);
  } catch (error) {
    log(`Workspace scan failed: ${String(error)}`);
  }
  scheduleDependencyScan();
}

connection.onInitialized(async () => {
  if (hasConfiguration) {
    await connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
  await refreshSettings();
  void scanWorkspace(workspaceFolders);
  connection.workspace.onDidChangeWorkspaceFolders((event) => {
    const added = event.added.map((f) => folderPath(f.uri)).filter((p): p is string => !!p);
    workspaceFolders.push(...added);
    void scanWorkspace(added);
    for (const removed of event.removed) {
      const prefix = removed.uri.endsWith('/') ? removed.uri : `${removed.uri}/`;
      for (const uri of [...index.files.keys()]) {
        if (uri.startsWith(prefix) && !documents.get(uri)) index.remove(uri);
      }
      workspaceFolders = workspaceFolders.filter((p) => p !== folderPath(removed.uri));
    }
  });
});

// ---------------------------------------------------------------------------
// Documents and diagnostics

const pendingValidation = new Map<string, NodeJS.Timeout>();

function publishDiagnostics(uri: string): void {
  const file = index.get(uri);
  const diagnostics = settings.diagnostics.enabled && file ? providers.diagnostics(file) : [];
  void connection.sendDiagnostics({ uri, diagnostics });
}

function scheduleValidation(uri: string): void {
  const existing = pendingValidation.get(uri);
  if (existing) clearTimeout(existing);
  pendingValidation.set(
    uri,
    setTimeout(() => {
      pendingValidation.delete(uri);
      publishDiagnostics(uri);
    }, 150),
  );
}

documents.onDidChangeContent((event) => {
  index.update(event.document.uri, event.document.getText(), { fromDisk: false });
  scheduleValidation(event.document.uri);
  if (event.document.uri.endsWith('.asd')) scheduleDependencyScan(2000);
});

documents.onDidClose((event) => {
  const uri = event.document.uri;
  const pending = pendingValidation.get(uri);
  if (pending) {
    clearTimeout(pending);
    pendingValidation.delete(uri);
  }
  void connection.sendDiagnostics({ uri, diagnostics: [] });
  void index.refreshFromDisk(uri);
});

connection.onDidChangeWatchedFiles((event) => {
  let asdChanged = false;
  for (const change of event.changes) {
    if (change.uri.endsWith('.asd') || change.uri.endsWith('ocicl.csv')) asdChanged = true;
    if (documents.get(change.uri)) continue;
    if (change.type === FileChangeType.Deleted) index.remove(change.uri);
    else void index.refreshFromDisk(change.uri);
  }
  if (asdChanged) scheduleDependencyScan(2000);
});

connection.onDidChangeConfiguration(async () => {
  await refreshSettings();
  for (const document of documents.all()) publishDiagnostics(document.uri);
  scheduleDependencyScan(500);
});

function fileFor(uri: string): IndexedFile | undefined {
  const file = index.get(uri);
  if (file && !file.fromDisk) return file;
  const document = documents.get(uri);
  if (document) return index.update(uri, document.getText(), { fromDisk: false });
  return file;
}

// ---------------------------------------------------------------------------
// Formatting

function operatorArity(name: string): number | undefined {
  const standard = lookupStandard(name);
  if (standard) {
    if (standard.kinds.includes('macro') || standard.kinds.includes('special-operator')) {
      return (standard.arglist ? bodyArity(standard.arglist) : undefined) ?? -1;
    }
    return -1;
  }
  const definitions = index.findDefinitions(name);
  for (const found of definitions) {
    if (found.def.kind === 'macro') return (found.def.lambdaList ? bodyArity(found.def.lambdaList) : undefined) ?? -1;
  }
  if (definitions.some((f) => ['function', 'generic', 'method', 'accessor', 'setf'].includes(f.def.kind))) return -1;
  return undefined;
}

function indentSettings(): IndentSettings {
  const result = defaultIndentSettings();
  for (const [name, count] of Object.entries(settings.indentation.specs)) result.specs.set(name.toUpperCase(), count);
  result.operatorArity = operatorArity;
  return result;
}

function toTextEdits(parse: ParseResult, edits: OffsetEdit[]): TextEdit[] {
  return edits.map((edit) => TextEdit.replace(Range.create(positionAt(parse, edit.start), positionAt(parse, edit.end)), edit.newText));
}

connection.onDocumentFormatting((params) => {
  const file = fileFor(params.textDocument.uri);
  if (!file) return [];
  return toTextEdits(file.parse, reindentLines(file.parse, 0, file.parse.lineStarts.length - 1, indentSettings()));
});

connection.onDocumentRangeFormatting((params) => {
  const file = fileFor(params.textDocument.uri);
  if (!file) return [];
  const lastLine = Math.min(params.range.end.line, file.parse.lineStarts.length - 1);
  return toTextEdits(file.parse, reindentLines(file.parse, params.range.start.line, lastLine, indentSettings()));
});

connection.onDocumentOnTypeFormatting((params) => {
  if (params.ch !== '\n') return [];
  const file = fileFor(params.textDocument.uri);
  if (!file) return [];
  const parse = file.parse;
  const line = params.position.line;
  if (line >= parse.lineStarts.length) return [];
  const indent = indentationForLine(parse, line, indentSettings());
  if (indent === null) return [];
  const lineStart = parse.lineStarts[line];
  let end = lineStart;
  while (end < parse.text.length && (parse.text[end] === ' ' || parse.text[end] === '\t')) end++;
  const desired = ' '.repeat(indent);
  if (parse.text.slice(lineStart, end) === desired) return [];
  return [TextEdit.replace(Range.create(positionAt(parse, lineStart), positionAt(parse, end)), desired)];
});

// ---------------------------------------------------------------------------
// Language features

connection.onHover((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? providers.hover(ctx, file, params.position) : null;
});

connection.onCompletion((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? providers.completion(ctx, file, params.position) : null;
});

connection.onCompletionResolve((item: CompletionItem) => providers.resolveCompletion(ctx, item));

connection.onSignatureHelp((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? providers.signatureHelp(ctx, file, params.position) : null;
});

connection.onDefinition((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? providers.definition(ctx, file, params.position) : null;
});

connection.onReferences((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? providers.references(ctx, file, params.position) : null;
});

connection.onDocumentHighlight((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? providers.documentHighlights(file, params.position) : null;
});

connection.onPrepareRename((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? providers.prepareRename(file, params.position) : null;
});

connection.onRenameRequest((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? providers.rename(ctx, file, params.position, params.newName) : null;
});

connection.onDocumentSymbol((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? providers.documentSymbols(file) : null;
});

connection.onWorkspaceSymbol((params) => providers.workspaceSymbols(ctx, params.query));

connection.onFoldingRanges((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? providers.foldingRanges(file) : null;
});

connection.onSelectionRanges((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? providers.selectionRanges(file, params.positions) : null;
});

connection.languages.semanticTokens.on((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? providers.semanticTokens(ctx, file) : { data: [] };
});

connection.onShutdown(() => {
  for (const timeout of pendingValidation.values()) clearTimeout(timeout);
  pendingValidation.clear();
  if (dependencyScanTimer) clearTimeout(dependencyScanTimer);
  live.disconnect();
});

documents.listen(connection);
connection.listen();
