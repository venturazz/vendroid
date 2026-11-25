// Tools for agents (Hermes Agent, CLI scripts). Exposed over MCP (POST /mcp, JSON-RPC) and REST
// (GET /api/agent/tools, POST /api/agent/tools/:name). Same validation as the dashboard; nothing
// here accepts shell text.
import { config } from './config.js';
import * as adbm from './adb.js';
import * as ai from './ai.js';
import * as files from './files.js';
import * as git from './git.js';
import * as aicode from './aicode.js';
import { TASKS, HttpError, bad, isSerial, isTcpTarget, isBuildId, isLevel } from './validate.js';

const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = {
  project: { type: 'string', description: 'Project id (folder name), from list_projects' },
  path: { type: 'string', description: 'File path relative to the project root, e.g. app/src/main/AndroidManifest.xml' },
  serial: { type: 'string', description: 'Device serial or tunnel address <ip>:<port>; default: DEFAULT_DEVICE_ADDRESS / first online device' },
};
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function createAgentTools({ projects, builds, watchdog }) {
  const proj = (id) => {
    if (typeof id !== 'string') throw bad('project is required');
    return projects.get(id);
  };
  const device = async (serial) => {
    if (serial) {
      if (!isSerial(serial)) throw bad('Invalid serial');
      return serial;
    }
    const online = (await adbm.listDevices()).find((d) => d.state === 'device');
    if (online) return online.serial;
    if (config.defaultDevice) return config.defaultDevice;
    throw bad('No device connected');
  };
  const buildSummary = (b, tail = 0) => ({ ...builds.view(b), ...(tail ? { logTail: builds.tail(b.id, tail) } : {}) });
  const writeGuard = () => { if (!config.mcpAllowWrite) throw new HttpError(403, 'Write tools are disabled (MCP_ALLOW_WRITE=false)'); };

  const tools = [
    {
      name: 'list_projects',
      description: 'List Android projects in the workspace with package, module and UI toolkit.',
      inputSchema: obj({}),
      run: () => projects.list().map(({ id, name, packageName, module, ui, versionName, git: isGit }) => ({ id, name, packageName, module, ui, versionName, git: isGit })),
    },
    {
      name: 'project_info',
      description: 'Details of one project, including git status and the last builds.',
      inputSchema: obj({ project: S.project }, ['project']),
      run: async ({ project }) => {
        const p = proj(project);
        return { ...p, gitStatus: p.git ? await git.status(p.path) : null, builds: builds.list(p.id).slice(0, 5) };
      },
    },
    {
      name: 'list_files',
      description: 'List files of a project (recursive, build output excluded).',
      inputSchema: obj({ project: S.project, prefix: { type: 'string', description: 'Only paths starting with this' } }, ['project']),
      run: ({ project, prefix }) => {
        const all = files.allFiles(proj(project).path, 5000);
        return prefix ? all.filter((f) => f.startsWith(prefix)) : all;
      },
    },
    {
      name: 'read_file',
      description: 'Read a text file from a project.',
      inputSchema: obj({ project: S.project, path: S.path }, ['project', 'path']),
      run: ({ project, path }) => files.read(proj(project).path, path),
    },
    {
      name: 'search_code',
      description: 'Case-insensitive text search across project source files.',
      inputSchema: obj({ project: S.project, query: { type: 'string' } }, ['project', 'query']),
      run: ({ project, query }) => files.search(proj(project).path, query, { limit: 200 }),
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a text file in a project. Prefer apply_edits for changes to existing files.',
      inputSchema: obj({ project: S.project, path: S.path, content: { type: 'string' } }, ['project', 'path', 'content']),
      write: true,
      run: ({ project, path, content }) => {
        const p = proj(project);
        if (/(^|\/)(build|\.gradle)(\/|$)|gradle-wrapper\.jar$|\.(jks|keystore)$/.test(path)) throw bad('path not allowed');
        let before = null;
        if (files.currentHash(p.path, path) !== null) {
          const cur = files.read(p.path, path);
          if (cur.content === undefined) throw bad('Refusing to overwrite a binary or very large file');
          before = cur.content;
        }
        const changed = [{ path, before, after: content, beforeHash: before === null ? null : files.currentHash(p.path, path) }];
        return aicode.applyChanges(p, changed, { source: 'agent' });
      },
    },
    {
      name: 'apply_edits',
      description: 'Apply SEARCH/REPLACE edit blocks (format: path line, "<<<<<<< SEARCH", old text, "=======", new text, ">>>>>>> REPLACE"; empty SEARCH creates/replaces the file). All blocks must apply or nothing is written. Returns an undo id and the diff.',
      inputSchema: obj({ project: S.project, edits: { type: 'string' } }, ['project', 'edits']),
      write: true,
      run: ({ project, edits }) => aicode.applyEditText(proj(project), edits),
    },
    {
      name: 'undo_edits',
      description: 'Revert an apply_edits/write_file call by its undo id.',
      inputSchema: obj({ project: S.project, undoId: { type: 'string' } }, ['project', 'undoId']),
      write: true,
      run: ({ project, undoId }) => aicode.undo(proj(project), undoId),
    },
    {
      name: 'git_status',
      description: 'Branch, ahead/behind and changed files.',
      inputSchema: obj({ project: S.project }, ['project']),
      run: ({ project }) => git.status(proj(project).path),
    },
    {
      name: 'git_diff',
      description: 'Unified diff of uncommitted changes (whole project or one file).',
      inputSchema: obj({ project: S.project, path: S.path }, ['project']),
      run: ({ project, path }) => git.diff(proj(project).path, path),
    },
    {
      name: 'git_commit',
      description: 'Stage all changes (or the given files) and commit.',
      inputSchema: obj({ project: S.project, message: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, ['project', 'message']),
      write: true,
      run: ({ project, message, files: list }) => git.commit(proj(project).path, { message, files: list }),
    },
    {
      name: 'git_pull',
      description: 'Fast-forward pull from the upstream branch.',
      inputSchema: obj({ project: S.project }, ['project']),
      write: true,
      run: ({ project }) => git.pull(proj(project).path),
    },
    {
      name: 'git_push',
      description: 'Push the current branch (sets upstream on first push).',
      inputSchema: obj({ project: S.project }, ['project']),
      write: true,
      run: ({ project }) => git.push(proj(project).path),
    },
    {
      name: 'start_build',
      description: `Queue a Gradle build (${Object.keys(TASKS).join(', ')}). Optionally install + launch on the phone. With waitSeconds the call blocks until the build ends (max 900) and returns the log tail.`,
      inputSchema: obj({
        project: S.project,
        task: { type: 'string', enum: Object.keys(TASKS), default: 'assembleDebug' },
        install: { type: 'boolean', default: false },
        launch: { type: 'boolean', default: false },
        gitPull: { type: 'boolean', default: false },
        serial: S.serial,
        waitSeconds: { type: 'integer', minimum: 0, maximum: 900, default: 0 },
      }, ['project']),
      run: async ({ project, task = 'assembleDebug', install = false, launch = false, gitPull = false, serial, waitSeconds = 0 }) => {
        const p = proj(project);
        const dev = install || launch ? await device(serial) : undefined;
        const b = builds.enqueue(p.id, {
          task, gitPullBeforeBuild: !!gitPull, autoInstallAfterBuild: !!(install || launch), autoLaunchAfterInstall: !!launch,
          ...(dev ? { deviceSerial: dev } : {}),
        }, { trigger: 'agent' });
        const until = Date.now() + Math.min(Number(waitSeconds) || 0, 900) * 1000;
        while (Date.now() < until) {
          const cur = builds.get(b.id);
          if (TERMINAL.includes(cur.state)) return buildSummary(cur, 120);
          await sleep(1000);
        }
        return buildSummary(builds.get(b.id), waitSeconds ? 60 : 0);
      },
    },
    {
      name: 'get_build',
      description: 'State of a build plus the last log lines.',
      inputSchema: obj({ buildId: { type: 'string' }, tailLines: { type: 'integer', minimum: 0, maximum: 2000, default: 120 } }, ['buildId']),
      run: ({ buildId, tailLines = 120 }) => {
        if (!isBuildId(buildId)) throw bad('Invalid buildId');
        return buildSummary(builds.get(buildId), tailLines);
      },
    },
    {
      name: 'list_builds',
      description: 'Recent builds of a project (newest first).',
      inputSchema: obj({ project: S.project }, ['project']),
      run: ({ project }) => builds.list(proj(project).id).slice(0, 20),
    },
    {
      name: 'cancel_build',
      description: 'Cancel a queued or running build.',
      inputSchema: obj({ buildId: { type: 'string' } }, ['buildId']),
      run: ({ buildId }) => builds.cancel(buildId),
    },
    {
      name: 'analyze_build_error',
      description: 'Ask 9Router for root cause, affected files and fix steps of a failed build.',
      inputSchema: obj({ buildId: { type: 'string' } }, ['buildId']),
      run: async ({ buildId }) => {
        if (!isBuildId(buildId)) throw bad('Invalid buildId');
        const r = await ai.analyze({ mode: 'build_error', text: builds.tail(buildId, 800) });
        return { analysis: r.analysis, raw: r.analysis ? undefined : r.raw };
      },
    },
    {
      name: 'list_devices',
      description: 'Connected Android devices (adb devices -l).',
      inputSchema: obj({}),
      run: async () => ({ devices: await adbm.listDevices(), autoReconnect: watchdog.view() }),
    },
    {
      name: 'connect_device',
      description: 'adb connect to a phone over the VPN tunnel.',
      inputSchema: obj({ target: { type: 'string', description: '<tunnel_ip>:<port>' } }, ['target']),
      run: ({ target }) => {
        if (!isTcpTarget(target)) throw bad('target must be <ipv4>:<port>');
        watchdog.noteManual('connect', target);
        return adbm.connect(target);
      },
    },
    {
      name: 'device_action',
      description: 'install (latest successful APK of the project, or buildId), launch, stop (force-stop) or clear (app data).',
      inputSchema: obj({
        action: { type: 'string', enum: ['install', 'launch', 'stop', 'clear'] },
        project: S.project, serial: S.serial, buildId: { type: 'string' },
      }, ['action', 'project']),
      run: async ({ action, project, serial, buildId }) => {
        const p = proj(project);
        const s = await device(serial);
        if (action === 'install') {
          const b = buildId ? builds.get(buildId) : builds.latestApk(p.id);
          const apk = b && builds.apkPath(b);
          if (!apk) throw new HttpError(404, 'No built APK for this project; run start_build first');
          return { ...(await adbm.installApk(s, apk)), buildId: b.id };
        }
        if (!['launch', 'stop', 'clear'].includes(action)) throw bad('Unknown action');
        if (!p.packageName) throw bad('Project has no package name');
        return adbm.deviceAction(action, s, p.packageName);
      },
    },
    {
      name: 'screenshot',
      description: 'PNG screenshot of the phone screen.',
      inputSchema: obj({ serial: S.serial }),
      image: true,
      run: async ({ serial }) => adbm.screenshot(await device(serial)),
    },
    {
      name: 'logcat',
      description: 'Recent logcat lines (one-shot dump), optionally only from the project app and above a level.',
      inputSchema: obj({
        serial: S.serial, project: S.project,
        level: { type: 'string', enum: ['V', 'D', 'I', 'W', 'E'], default: 'I' },
        lines: { type: 'integer', minimum: 10, maximum: 5000, default: 300 },
        query: { type: 'string' },
      }),
      run: async ({ serial, project, level = 'I', lines = 300, query = '' }) => {
        if (!isLevel(level)) throw bad('Invalid level');
        const pkg = project ? proj(project).packageName || '' : '';
        return adbm.logcatDump(await device(serial), { lines, minLevel: level, packageName: pkg, q: query });
      },
    },
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));

  return {
    list: () => tools.filter((t) => config.mcpAllowWrite || !t.write)
      .map(({ name, description, inputSchema, write }) => ({ name, description, inputSchema, annotations: { readOnlyHint: !write } })),
    async call(name, args = {}) {
      const t = byName.get(name);
      if (!t) throw new HttpError(404, `Unknown tool ${name}`);
      if (t.write) writeGuard();
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw bad('arguments must be an object');
      const allowed = Object.keys(t.inputSchema.properties);
      const extra = Object.keys(args).filter((k) => !allowed.includes(k));
      if (extra.length) throw bad(`Unknown argument(s): ${extra.join(', ')}`);
      for (const k of t.inputSchema.required) if (args[k] === undefined) throw bad(`Missing argument: ${k}`);
      const value = await t.run(args);
      return { image: !!t.image, value };
    },
  };
}
