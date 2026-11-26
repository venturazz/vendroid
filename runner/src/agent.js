// Tools for agents (Hermes Agent, CLI scripts). Exposed over MCP (POST /mcp, JSON-RPC) and REST
// (GET /api/agent/tools, POST /api/agent/tools/:name). Same validation as the dashboard; nothing
// here accepts shell text.
import fs from 'node:fs';
import { config } from './config.js';
import * as adbm from './adb.js';
import * as ai from './ai.js';
import * as files from './files.js';
import * as git from './git.js';
import * as aicode from './aicode.js';
import * as play from './play.js';
import { imageInfo, mimeFor } from './imageinfo.js';
import { TASKS, HttpError, bad, isSerial, isTcpTarget, isBuildId, isLevel } from './validate.js';
import { TEMPLATE_IDS } from './projects.js';

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
      name: 'create_project',
      description: `Create a new Android project from a template and open it in the workspace (git repo with a first commit). Templates: compose (Jetpack Compose, Material 3), views (XML layouts, ViewBinding), webview (offline HTML/CSS/JS app in app/src/main/assets/www — use this for HTML games and web apps). Targets the newest Android; minSdk 21-36 (default 24). Returns the project id to use with the other tools.`,
      inputSchema: obj({
        name: { type: 'string', description: 'App name, 1-40 letters/digits/spaces starting with a letter, e.g. "Bola Pecah"' },
        packageName: { type: 'string', description: 'Unique application id, e.g. com.venturabyte.bolapecah (never com.example.*)' },
        template: { type: 'string', enum: TEMPLATE_IDS, default: 'compose' },
        minSdk: { type: 'integer', minimum: 21, maximum: 36, default: 24 },
      }, ['name', 'packageName']),
      write: true,
      run: (args) => projects.create(args),
    },
    {
      name: 'clone_project',
      description: 'Clone a git repository (https URL) into the workspace as a new project. Private repos work when the server has GIT_TOKEN.',
      inputSchema: obj({ url: { type: 'string', description: 'https://… clone URL' }, branch: { type: 'string' } }, ['url']),
      write: true,
      run: ({ url, branch }) => projects.clone({ url, branch }),
    },
    {
      name: 'rename_project',
      description: 'Change the display name (and optionally the package used for launch/logcat) of a project. The folder id stays the same.',
      inputSchema: obj({ project: S.project, name: { type: 'string' }, packageName: { type: 'string' } }, ['project']),
      write: true,
      run: ({ project, name, packageName }) => projects.update(proj(project).id, { ...(name !== undefined ? { name } : {}), ...(packageName !== undefined ? { packageName } : {}) }),
    },
    {
      name: 'delete_project',
      description: 'Move a project to the trash (restorable for 7 days with restore_project). Set confirm to the project id. Cancel running builds first.',
      inputSchema: obj({ project: S.project, confirm: { type: 'string', description: 'Must equal the project id' } }, ['project', 'confirm']),
      write: true,
      run: ({ project, confirm }) => {
        const p = proj(project);
        const q = builds.queueView();
        if (q.activeProject === p.id || q.queued.some((id) => builds.get(id).projectId === p.id)) throw new HttpError(409, 'This project has a running or queued build; cancel it first');
        return projects.remove(p.id, confirm);
      },
    },
    {
      name: 'list_trash',
      description: 'Deleted projects that can still be restored.',
      inputSchema: obj({}),
      run: () => projects.listTrash(),
    },
    {
      name: 'restore_project',
      description: 'Restore a deleted project from the trash (entry from list_trash).',
      inputSchema: obj({ entry: { type: 'string' } }, ['entry']),
      write: true,
      run: ({ entry }) => projects.restore(entry),
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
      description: 'List files of a project (recursive, build output excluded). detailed=true adds size and, for images, type and pixel size.',
      inputSchema: obj({ project: S.project, prefix: { type: 'string', description: 'Only paths starting with this' }, detailed: { type: 'boolean', default: false } }, ['project']),
      run: ({ project, prefix, detailed = false }) => {
        const p = proj(project);
        const all = files.allFiles(p.path, 5000).filter((f) => !prefix || f.startsWith(prefix));
        if (!detailed) return all;
        return all.slice(0, 2000).map((f) => {
          const abs = files.resolve(p.path, f);
          const size = fs.statSync(abs).size;
          let image;
          if (/\.(png|jpe?g|webp|gif)$/i.test(f) && size < files.MAX_BINARY) {
            const fd = fs.openSync(abs, 'r');
            const head = Buffer.alloc(Math.min(size, 65536));
            fs.readSync(fd, head, 0, head.length, 0);
            fs.closeSync(fd);
            image = imageInfo(head) || undefined;
          }
          return { path: f, size, ...(image ? { image } : {}) };
        });
      },
    },
    {
      name: 'read_binary_file',
      description: 'Read any file as bytes. Images (png/jpg/webp/gif) come back as an image you can see; other files (sounds, fonts, …) as base64. Max 25 MB.',
      inputSchema: obj({ project: S.project, path: S.path }, ['project', 'path']),
      binary: true,
      run: ({ project, path: rel }) => {
        const buf = files.readBytes(proj(project).path, rel);
        const info = imageInfo(buf);
        if (info && info.type !== 'svg') return { kind: 'image', mime: `image/${info.type}`, data: buf, meta: { path: rel, size: buf.length, ...info } };
        return { kind: 'json', value: { path: rel, size: buf.length, mime: mimeFor(rel), sha1: files.sha1(buf), base64: buf.toString('base64') } };
      },
    },
    {
      name: 'write_binary_file',
      description: 'Create or replace a binary file from base64: PNG/WebP icons and images (e.g. app/src/main/res/mipmap-xxhdpi/ic_launcher.png), sounds (res/raw/*.mp3|ogg|wav), fonts (res/font/*.ttf), assets. Max 25 MB. Returns size, image dimensions and an undo id. Android resource file names must be lowercase a-z, 0-9 and _.',
      inputSchema: obj({ project: S.project, path: S.path, base64: { type: 'string', description: 'File content, base64 (a data: URL prefix is allowed)' } }, ['project', 'path', 'base64']),
      write: true,
      run: ({ project, path: rel, base64 }) => {
        const p = proj(project);
        const b64 = String(base64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/=_-]*$/.test(b64)) throw bad('base64 contains invalid characters');
        const bytes = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        if (!bytes.length) throw bad('decoded content is empty');
        if (/(^|\/)res\/[a-z]+(-[a-z0-9]+)*\/[^/]+$/.test(rel) && !/\/[a-z0-9_]+(\.9)?\.[a-z0-9]+$/.test(rel)) {
          throw bad('Android resource file names must be lowercase letters, digits and _ (e.g. ic_launcher.png)');
        }
        const info = imageInfo(bytes);
        const ext = rel.toLowerCase().split('.').pop();
        if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext) && (!info || (info.type !== ext && !(ext === 'jpg' && info.type === 'jpeg')))) {
          throw bad(`Content is not a valid .${ext} image${info ? ` (looks like ${info.type})` : ''}`);
        }
        return { ...aicode.fileOp(p, { type: 'write', path: rel, bytes }), ...(info ? { image: info } : {}) };
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a file (any type). Undo with undo_edits and the returned undo id. Folders: move or git.',
      inputSchema: obj({ project: S.project, path: S.path }, ['project', 'path']),
      write: true,
      run: ({ project, path: rel }) => aicode.fileOp(proj(project), { type: 'delete', path: rel }),
    },
    {
      name: 'move_file',
      description: 'Rename or move a file inside the project (any type), with undo.',
      inputSchema: obj({ project: S.project, path: S.path, to: { type: 'string', description: 'New path relative to the project root' } }, ['project', 'path', 'to']),
      write: true,
      run: ({ project, path: rel, to }) => aicode.fileOp(proj(project), { type: 'move', path: rel, to }),
    },
    {
      name: 'make_dir',
      description: 'Create a folder (and parents), e.g. app/src/main/res/raw.',
      inputSchema: obj({ project: S.project, path: S.path }, ['project', 'path']),
      write: true,
      run: ({ project, path: rel }) => {
        if (aicode.FORBIDDEN.test(rel)) throw bad('path not allowed');
        return files.mkdir(proj(project).path, rel);
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
      name: 'git_branches',
      description: 'Local branches; the current one is marked.',
      inputSchema: obj({ project: S.project }, ['project']),
      run: ({ project }) => git.branches(proj(project).path),
    },
    {
      name: 'git_checkout',
      description: 'Switch to a branch, or create it with create=true (e.g. ai/login-screen before a big change).',
      inputSchema: obj({ project: S.project, branch: { type: 'string' }, create: { type: 'boolean', default: false } }, ['project', 'branch']),
      write: true,
      run: ({ project, branch, create = false }) => git.checkout(proj(project).path, { branch, create }),
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
      name: 'play_check',
      description: `Google Play readiness of a project: target API ${play.PLAY_TARGET_SDK}+, unique applicationId, versionCode, upload key, debuggable, R8, sensitive permissions, signed .aab, 16 KB page-size alignment of native libraries.`,
      inputSchema: obj({ project: S.project }, ['project']),
      run: ({ project }) => {
        const p = proj(project);
        const rel = builds.list(p.id).filter((b) => b.state === 'succeeded' && ['assembleRelease', 'bundleRelease'].includes(b.task) && b.apk)
          .map((b) => ({ ...b, artifactType: b.artifactType || b.apk.type, apkSize: b.apk.size }));
        return play.checks(p, rel, (b) => builds.apkPath(builds.get(b.id)));
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
          if (b?.artifactType === 'aab') throw bad('An .aab cannot be installed with adb');
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
      if (t.image) return { image: true, mime: 'image/png', value };
      if (t.binary && value.kind === 'image') return { image: true, mime: value.mime, value: value.data, meta: value.meta };
      if (t.binary) return { image: false, value: value.value };
      return { image: false, value };
    },
  };
}
