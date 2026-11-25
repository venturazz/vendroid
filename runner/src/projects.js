// Project Hub: every folder in WORKSPACES_DIR is a project. Metadata (display name, package
// override, last opened) lives in DATA_DIR/projects/<id>/project.json; build info is read from
// the Gradle files so it stays correct when the user edits them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HttpError, bad, isPackage, isProjectId, isModule, isCloneUrl, isBranch } from './validate.js';
import * as git from './git.js';

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
export const TEMPLATE_IDS = ['compose', 'views'];

/** Versions the templates use (shown in the New Project dialog). */
export function templateVersions() {
  const v = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'versions.json'), 'utf8'));
  return { compileSdk: v.compileSdkMinor ? `${v.compileSdk}.${v.compileSdkMinor}` : String(v.compileSdk), targetSdk: v.targetSdk, agp: v.agp, gradle: v.gradle, kotlin: v.kotlin };
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

function metaFile(id) { return path.join(config.projectsDir, id, 'project.json'); }

/** Human name -> folder id ("My Cool App" -> "my-cool-app"). */
export function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'app';
}

/** Parse the facts the IDE needs from the Gradle build files (no Gradle invocation). */
export function inspectProject(dir) {
  const settings = readText(path.join(dir, 'settings.gradle.kts')) || readText(path.join(dir, 'settings.gradle'));
  const includes = [...settings.matchAll(/["']:([A-Za-z0-9_\-:]+)["']/g)].map((m) => m[1]);
  // The application module is the included module applying com.android.application.
  let module = null;
  let build = '';
  for (const m of includes.length ? includes : ['app']) {
    const base = path.join(dir, ...m.split(':'));
    const b = readText(path.join(base, 'build.gradle.kts')) || readText(path.join(base, 'build.gradle'));
    if (/com\.android\.application|alias\(libs\.plugins\.android\.application\)|android\.application/.test(b)) {
      module = m;
      build = b;
      break;
    }
    if (!module && b) { module = m; build = b; }
  }
  const pick = (re) => (re.exec(build) || [])[1] || null;
  const applicationId = pick(/applicationId\s*=?\s*["']([^"']+)["']/);
  const namespace = pick(/namespace\s*=?\s*["']([^"']+)["']/);
  const compose = /compose\s*=\s*true|compose\s+true|kotlin\.plugin\.compose|plugins\.compose/.test(build);
  return {
    android: !!settings || fs.existsSync(path.join(dir, 'gradlew')),
    hasGradlew: fs.existsSync(path.join(dir, 'gradlew')),
    module: module || 'app',
    packageName: applicationId || namespace,
    versionName: pick(/versionName\s*=?\s*["']([^"']+)["']/),
    versionCode: Number(pick(/versionCode\s*=?\s*(\d+)/)) || null,
    minSdk: Number(pick(/minSdk(?:Version)?\s*=?\s*(\d+)/)) || null,
    targetSdk: Number(pick(/targetSdk(?:Version)?\s*=?\s*(\d+)/)) || null,
    ui: compose ? 'compose' : 'views',
  };
}

export class ProjectStore {
  constructor() {
    this.root = config.workspacesDir;
  }

  init() {
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(config.projectsDir, { recursive: true });
  }

  dir(id) {
    if (!isProjectId(id)) throw bad('Invalid project id');
    return path.join(this.root, id);
  }

  exists(id) {
    try { return isProjectId(id) && fs.statSync(this.dir(id)).isDirectory(); } catch { return false; }
  }

  meta(id) { return readJson(metaFile(id), {}); }

  saveMeta(id, patch) {
    const m = { ...this.meta(id), ...patch };
    fs.mkdirSync(path.dirname(metaFile(id)), { recursive: true });
    fs.writeFileSync(metaFile(id), JSON.stringify(m, null, 2));
    return m;
  }

  /** Full project record (cheap: reads a few small files). */
  get(id) {
    if (!isProjectId(id)) throw bad('Invalid project id');
    if (!this.exists(id)) throw new HttpError(404, `Project ${id} not found`);
    const dir = this.dir(id);
    const info = inspectProject(dir);
    const m = this.meta(id);
    return {
      id,
      name: m.name || id,
      path: dir,
      ...info,
      module: m.module || info.module,
      packageName: m.packageName || info.packageName || (id === this.legacyId() ? config.defaultPackage || null : null),
      git: fs.existsSync(path.join(dir, '.git')),
      template: m.template || null,
      createdAt: m.createdAt || null,
      lastOpenedAt: m.lastOpenedAt || null,
    };
  }

  /** Folder name of the v1 single project (ANDROID_PROJECT_PATH), if it lives in WORKSPACES_DIR. */
  legacyId() {
    if (!config.projectPath) return null;
    const id = path.basename(path.resolve(config.projectPath));
    try {
      return isProjectId(id) && fs.realpathSync(path.join(this.root, id)) === fs.realpathSync(config.projectPath) ? id : null;
    } catch { return null; }
  }

  list() {
    let ents = [];
    try { ents = fs.readdirSync(this.root, { withFileTypes: true }); } catch { /* none yet */ }
    return ents
      .filter((e) => (e.isDirectory() || (e.isSymbolicLink() && this.exists(e.name))) && !e.name.startsWith('.') && isProjectId(e.name))
      .map((e) => {
        try { return this.get(e.name); } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.lastOpenedAt || b.createdAt || '').localeCompare(a.lastOpenedAt || a.createdAt || '') || a.id.localeCompare(b.id));
  }

  update(id, body) {
    this.get(id);
    const patch = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60) throw bad('name must be 1-60 characters');
      patch.name = body.name.trim();
    }
    if (body.packageName !== undefined) {
      if (body.packageName !== '' && !isPackage(body.packageName)) throw bad('Invalid package name');
      patch.packageName = body.packageName || undefined;
    }
    if (body.module !== undefined) {
      if (body.module !== '' && !isModule(body.module)) throw bad('Invalid module');
      patch.module = body.module || undefined;
    }
    if (body.opened) patch.lastOpenedAt = new Date().toISOString();
    this.saveMeta(id, patch);
    return this.get(id);
  }

  #freeId(name) {
    const base = slugify(name);
    let id = base;
    for (let i = 2; this.exists(id) || fs.existsSync(path.join(this.root, id)); i++) id = `${base}-${i}`;
    return id;
  }

  /** New project from a bundled template, committed as the first git commit. */
  async create({ name, packageName, template = 'compose', minSdk = 24 }) {
    if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9 ]{0,39}$/.test(name.trim())) {
      throw bad('App name: 1-40 letters, digits or spaces, starting with a letter');
    }
    if (!isPackage(packageName)) throw bad('Invalid package name (e.g. com.example.myapp)');
    if (packageName.split('.').some((p) => KOTLIN_KEYWORDS.has(p))) throw bad('Package segments must not be Kotlin keywords');
    if (!TEMPLATE_IDS.includes(template)) throw bad(`template must be one of: ${TEMPLATE_IDS.join(', ')}`);
    minSdk = Number(minSdk);
    if (!Number.isInteger(minSdk) || minSdk < 21 || minSdk > 36) throw bad('minSdk must be 21-36');
    name = name.trim();
    const id = this.#freeId(name);
    const dir = path.join(this.root, id);
    const v = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'versions.json'), 'utf8'));
    const tokens = {
      __APP_NAME__: name, __PACKAGE__: packageName, __PACKAGE_PATH__: packageName.replace(/\./g, '/'),
      __MIN_SDK__: String(minSdk), __TARGET_SDK__: String(v.targetSdk), __COMPILE_SDK__: String(v.compileSdk),
      __COMPILE_SDK_MINOR__: String(v.compileSdkMinor), __GRADLE__: v.gradle, __AGP__: v.agp, __KOTLIN__: v.kotlin,
      __COMPOSE_BOM__: v.composeBom, __ACTIVITY__: v.activity, __CORE_KTX__: v.coreKtx, __LIFECYCLE__: v.lifecycle,
      __APPCOMPAT__: v.appcompat, __MATERIAL__: v.material, __CONSTRAINTLAYOUT__: v.constraintlayout, __JUNIT__: v.junit,
    };
    const subst = (s) => s.replace(/__[A-Z_]+__/g, (t) => tokens[t] ?? t);
    const copyTree = (src, dst) => {
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, e.name);
        const to = path.join(dst, subst(e.name));
        if (e.isDirectory()) {
          // __PACKAGE_PATH__ expands to nested folders
          fs.mkdirSync(to, { recursive: true });
          copyTree(from, to);
        } else {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.writeFileSync(to, subst(fs.readFileSync(from, 'utf8')));
        }
      }
    };
    try {
      fs.mkdirSync(dir);
      copyTree(path.join(TEMPLATES, template), dir);
      const c = path.join(TEMPLATES, 'common');
      const put = (rel, file) => {
        const to = path.join(dir, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, subst(fs.readFileSync(path.join(c, file), 'utf8')));
      };
      put('settings.gradle.kts', 'settings.gradle.kts');
      put('gradle.properties', 'gradle.properties');
      put('.gitignore', 'gitignore');
      put('app/proguard-rules.pro', 'proguard-rules.pro');
      put('gradle/wrapper/gradle-wrapper.properties', 'gradle-wrapper.properties');
      fs.copyFileSync(path.join(TEMPLATES, 'wrapper/gradle/wrapper/gradle-wrapper.jar'), path.join(dir, 'gradle/wrapper/gradle-wrapper.jar'));
      fs.copyFileSync(path.join(TEMPLATES, 'wrapper/gradlew'), path.join(dir, 'gradlew'));
      fs.copyFileSync(path.join(TEMPLATES, 'wrapper/gradlew.bat'), path.join(dir, 'gradlew.bat'));
      fs.chmodSync(path.join(dir, 'gradlew'), 0o755);
      await git.init(dir);
      await git.commit(dir, { message: `Create ${name} from the ${template} template` });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    this.saveMeta(id, { name, template, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() });
    return this.get(id);
  }

  /** Clone a remote (https only). Uses GIT_TOKEN for private repos. */
  async clone({ url, branch, name }) {
    if (!isCloneUrl(url)) throw bad('Clone URL must be https://… (no spaces or shell characters)');
    if (branch && !isBranch(branch)) throw bad('Invalid branch name');
    const repoName = name || decodeURIComponent(url.replace(/\/+$/, '').split('/').pop() || 'repo').replace(/\.git$/, '');
    const id = this.#freeId(repoName);
    const dir = path.join(this.root, id);
    const r = await git.clone(url, dir, branch);
    if (!r.ok) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new HttpError(502, `git clone failed: ${git.scrub(r.message)}`);
    }
    try { fs.chmodSync(path.join(dir, 'gradlew'), 0o755); } catch { /* not an Android project root */ }
    this.saveMeta(id, { name: repoName.slice(0, 60), createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), clonedFrom: git.scrub(url) });
    return this.get(id);
  }

  /** Delete the folder (and metadata). Requires the id typed back as confirmation. */
  remove(id, confirm) {
    this.get(id);
    if (confirm !== id) throw bad('Type the project id to confirm deletion');
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    fs.rmSync(path.join(config.projectsDir, id), { recursive: true, force: true });
    return { ok: true };
  }

  /** Project whose git remote matches a push webhook's repository URLs. */
  async findByRemote(urls) {
    const norm = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/([^@/]*@)?/, '').replace(/^git@([^:]+):/, '$1/').replace(/\.git$/, '').replace(/\/+$/, '');
    const wanted = new Set(urls.filter(Boolean).map(norm));
    for (const p of this.list()) {
      if (!p.git) continue;
      const remote = await git.remoteUrl(p.path);
      if (remote && wanted.has(norm(remote))) return p;
    }
    return null;
  }
}

const KOTLIN_KEYWORDS = new Set(['as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in',
  'interface', 'is', 'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias',
  'typeof', 'val', 'var', 'when', 'while']);
