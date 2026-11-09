import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Despliegue por registro de imágenes (deploy/lib/deploy-registro.sh, lado
 * local, y deploy/lib/remote-release.sh, lado servidor). Es bash: se prueba
 * `source`ando cada librería en un `bash -c` y, para el camino entero,
 * ejecutando deploy/publicar.sh de verdad sobre un repo git temporal.
 *
 * `docker`, `ssh`, `npm` y `node` son FALSOS (van delante en el PATH): apuntan
 * cada llamada en un fichero y responden según variables FAKE_*. Así se
 * comprueba el ORDEN de lo que haría (bajar la imagen antes de tocar el .env,
 * restaurar si compose falla, no construir ni desplegar con el gate en
 * rojo…) sin Docker, SSH ni registro. La consulta real al registro y
 * `--metadata-file` NO se prueban aquí: solo la decisión sobre lo que
 * devuelven (ver «Por comprobar en real» en el commit).
 */

vi.setConfig({ testTimeout: 60_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCAL_LIB = join(ROOT, 'deploy', 'lib', 'deploy-registro.sh');
const REMOTE_LIB = join(ROOT, 'deploy', 'lib', 'remote-release.sh');

const SHA = '7f7656c521e373a0c9a0d9ab63ca98071bda1dfd';
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const REG = 'git.dualhand.com/fodaveg/hebra-mcp';
const REF_A = `${REG}@${DIGEST_A}`;
const REF_B = `${REG}@${DIGEST_B}`;
const VAR = 'HEBRA_MCP_IMAGE';
const ARM64_JSON = '{"architecture":"arm64","os":"linux"}';
const SECRETS = '/srv/hebra-mcp/deploy/.env';

/** `docker` falso: apunta "$*" en $FAKE_LOG y responde según FAKE_*. */
const FAKE_DOCKER = `#!/usr/bin/env bash
args=("$@")
# compose: se quitan los --env-file para decidir el subcomando y se apuntan aparte
if [ "$1" = compose ]; then
  rest=(); envf=""; skip=0
  for a in "$@"; do
    if [ "$skip" = 1 ]; then envf="$envf $a"; skip=0; continue; fi
    if [ "$a" = --env-file ]; then skip=1; continue; fi
    rest+=("$a")
  done
  echo "\${rest[*]}" >> "$FAKE_LOG"
  echo "env-file=[\${envf# }] imagen=[\${HEBRA_MCP_IMAGE:-}] :: \${rest[*]}" >> "$FAKE_LOG.compose"
  set -- "\${rest[@]}"
else
  echo "$*" >> "$FAKE_LOG"
fi
last="\${!#}"
fmt=""; prev=""; meta=""
for a in "$@"; do
  [ "$prev" = "--format" ] && fmt="$a"
  [ "$prev" = "-f" ] && fmt="$a"
  [ "$prev" = "--metadata-file" ] && meta="$a"
  prev="$a"
done
case "$1" in
  network) exit 0 ;;
  inspect)
    case "$fmt" in
      *State.Running*) echo "\${FAKE_STATE:-true 0}"; exit 0 ;;
    esac
    [ -n "\${FAKE_CONTAINER:-}" ] || exit 1
    case "$fmt" in
      *Config.Labels*) echo "\${FAKE_REV:-}" ;;
      *Config.Image*) echo "$FAKE_CONTAINER" ;;
      *) : ;;
    esac
    exit 0 ;;
  stop) exit 0 ;;
  logs) echo "2026-11-08T00:00:00Z [hebra-mcp-http] tools/call 200"; exit 0 ;;
  tag) exit 0 ;;
  pull) exit "\${FAKE_PULL_RC:-0}" ;;
  image)
    [ "$2" = rm ] && exit 0
    for i in \${FAKE_LOCAL_IMAGES:-}; do
      if [ "\${i%%=*}" = "$last" ]; then [ -n "$fmt" ] && echo "\${i#*=}"; exit 0; fi
    done
    exit 1 ;;
  compose)
    if [ "$3" = --help ]; then echo "\${FAKE_COMPOSE_HELP-      --wait-timeout int   Maximum duration}"; exit 0; fi
    if [ "$2" = up ]; then
      n=$(cat "$FAKE_LOG.up" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_LOG.up"
      [ "$n" = 1 ] && exit "\${FAKE_UP_RC:-0}"
    fi
    exit 0 ;;
  buildx)
    if [ "$2" = build ]; then
      [ -n "$meta" ] && [ -n "\${FAKE_BUILD_DIGEST:-}" ] &&
        printf '{\\n  "containerimage.config.digest": "sha256:%064d",\\n  "containerimage.digest": "%s"\\n}\\n' 0 "$FAKE_BUILD_DIGEST" > "$meta"
      exit "\${FAKE_BUILD_RC:-0}"
    fi
    if [ -n "\${FAKE_INSPECT_ERR:-}" ]; then echo "$FAKE_INSPECT_ERR" >&2; exit 1; fi
    if [ -n "\${FAKE_MISSING:-}" ] && [ "$last" = "$FAKE_MISSING" ]; then
      echo "ERROR: $last: not found" >&2; exit 1
    fi
    case "$fmt" in
      *Digest*) echo "$FAKE_DIGEST" ;;
      *json*) [ -n "\${FAKE_JSON_RC:-}" ] && exit "$FAKE_JSON_RC"; echo "\${FAKE_IMAGE_JSON:-}" ;;
    esac
    exit 0 ;;
esac
exit 0
`;

/** `ssh` falso: apunta argumentos y script (stdin); sale con FAKE_SSH_RC. */
const FAKE_SSH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG.ssh"
cat >> "$FAKE_LOG.ssh.stdin"
exit "\${FAKE_SSH_RC:-0}"
`;

/** `npm` y `node` falsos: apuntan la llamada. `npm run check` sale con FAKE_GATE_RC y `npm run build` deja dist/cli.mjs. */
const FAKE_NODE = `#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$FAKE_LOG.node"
if [ "$(basename "$0")" = npm ] && [ "$1 $2" = "run check" ]; then
  echo gate >> "$FAKE_LOG.gate"
  exit "\${FAKE_GATE_RC:-0}"
fi
if [ "$(basename "$0")" = npm ] && [ "$1 $2" = "run build" ] && [ -z "\${FAKE_NO_DIST:-}" ]; then
  mkdir -p dist && echo "// compilado" > dist/cli.mjs
fi
exit 0
`;

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

let tmp: string;
let fakeLog: string;

function writeExec(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	chmodSync(path, 0o755);
}

/** Entorno común: binarios falsos delante, git aislado de la config del usuario. */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${join(tmp, 'bin')}:${process.env.PATH}`,
		FAKE_LOG: fakeLog,
		RELEASE_STABLE_SECS: '0',
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_AUTHOR_NAME: 't',
		GIT_AUTHOR_EMAIL: 't@t',
		GIT_COMMITTER_NAME: 't',
		GIT_COMMITTER_EMAIL: 't@t',
		DEPLOY_DRY_RUN: '',
		...extra
	};
	return env;
}

/** Ejecuta `script` en bash tras hacer `source` de `lib`, con los binarios falsos. */
function sh(lib: string, script: string, env: Record<string, string> = {}, cwd?: string): Run {
	const r = spawnSync('bash', ['-c', `source "${lib}"\n${script}`], {
		cwd: cwd ?? tmp,
		encoding: 'utf8',
		env: baseEnv(env)
	});
	return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** Líneas de un fichero de registro de los falsos ([] si no existe). */
function lines(file: string): string[] {
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
}

/** Llamadas que recibió el docker falso, una por línea. */
const dockerCalls = () => lines(fakeLog);

const COMPOSE = `services:\n  mcp:\n    image: '\${${VAR}:-hebra-mcp:latest}'\n    container_name: hebra-mcp\n`;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), 'hebra-mcp-deploy-'));
	fakeLog = join(tmp, 'docker.log');
	mkdirSync(join(tmp, 'srv'), { recursive: true });
	writeExec(join(tmp, 'bin', 'docker'), FAKE_DOCKER);
	writeExec(join(tmp, 'bin', 'ssh'), FAKE_SSH);
	writeExec(join(tmp, 'bin', 'npm'), FAKE_NODE);
	writeExec(join(tmp, 'bin', 'node'), FAKE_NODE);
	writeFileSync(join(tmp, 'srv', 'compose.yml'), COMPOSE);
});

afterEach(() => {
	chmodSync(tmp, 0o755);
	rmSync(tmp, { recursive: true, force: true });
});

describe('deploy_parse_args', () => {
	const parse = (args: string, env: Record<string, string> = {}) =>
		sh(
			LOCAL_LIB,
			`deploy_parse_args ${args}; rc=$?; echo "$rc|$DEPLOY_MODE|$DEPLOY_VERSION|$DEPLOY_DRY_RUN"`,
			env
		).stdout.trim();

	it('sin opciones: deploy normal, sin ensayo', () => {
		expect(parse('')).toBe('0|desplegar||0');
	});

	it('--dry-run y DEPLOY_DRY_RUN=1|true|yes (sin mayúsculas) encienden el ensayo en seco', () => {
		expect(parse('--dry-run')).toBe('0|desplegar||1');
		for (const on of ['1', 'true', 'YES', 'True']) {
			expect(parse('', { DEPLOY_DRY_RUN: on }), on).toBe('0|desplegar||1');
		}
		for (const off of ['0', 'si', '2', 'false', 'on']) {
			expect(parse('', { DEPLOY_DRY_RUN: off }), off).toBe('0|desplegar||0');
		}
	});

	it('--anterior, --historial y --version <sha> / --version=<sha>', () => {
		expect(parse('--anterior')).toBe('0|anterior||0');
		expect(parse('--historial')).toBe('0|historial||0');
		expect(parse('--version 7f7656c')).toBe('0|version|7f7656c|0');
		expect(parse(`--version=${SHA} --dry-run`)).toBe(`0|version|${SHA}|1`);
	});

	it('rechaza con código 2 lo que no tiene sentido (también la vía sin registro, que no existe)', () => {
		for (const bad of [
			'--version',
			'--version main',
			'--version 7F7656C',
			'--anterior --version 7f7656c',
			'--sin-registro',
			'--lo-que-sea'
		]) {
			expect(parse(bad).split('|')[0], bad).toBe('2');
		}
	});
});

describe('validadores', () => {
	const ok = (fn: string, value: string) => sh(LOCAL_LIB, `${fn} "$V"`, { V: value }).code === 0;

	it('is_digest solo acepta sha256 con 64 hexadecimales', () => {
		expect(ok('is_digest', DIGEST_A)).toBe(true);
		expect(ok('is_digest', 'sha256:abc')).toBe(false);
		expect(ok('is_digest', `sha512:${'a'.repeat(64)}`)).toBe(false);
	});

	it('is_commit_sha acepta de 7 a 40 hexadecimales en minúscula', () => {
		expect(ok('is_commit_sha', SHA)).toBe(true);
		expect(ok('is_commit_sha', '7f7656c')).toBe(true);
		expect(ok('is_commit_sha', '7f765')).toBe(false);
		expect(ok('is_commit_sha', 'HEAD')).toBe(false);
	});

	it('is_safe_image_ref rechaza lo que se podría interpretar en la shell remota', () => {
		expect(ok('is_safe_image_ref', REF_A)).toBe(true);
		expect(ok('is_safe_image_ref', 'hebra-mcp:previo-registro')).toBe(true);
		expect(ok('is_safe_image_ref', 'hebra-mcp;rm -rf /')).toBe(false);
		expect(ok('is_safe_image_ref', '$(id)')).toBe(false);
	});
});

describe('image_json_has_platform', () => {
	const has = (json: string, platform: string) =>
		sh(LOCAL_LIB, 'image_json_has_platform "$J" "$P"', { J: json, P: platform }).code === 0;

	const SINGLE_ARM64 =
		'{"created":"2026-11-08T11:53:37Z","architecture":"arm64","os":"linux","config":{"ExposedPorts":{"8787/tcp":{}}}}';
	const INDEX = `{
  "linux/amd64": { "architecture": "amd64", "os": "linux" },
  "linux/arm64": { "architecture": "arm64", "os": "linux", "variant": "v8" }
}`;
	const INDEX_AMD64 = '{"linux/amd64":{"architecture":"amd64","os":"linux"}}';

	it('manifiesto simple: mira architecture y os', () => {
		expect(has(SINGLE_ARM64, 'linux/arm64')).toBe(true);
		expect(has(SINGLE_ARM64, 'linux/amd64')).toBe(false);
	});

	it('índice: mira las claves por plataforma', () => {
		expect(has(INDEX, 'linux/arm64')).toBe(true);
		expect(has(INDEX_AMD64, 'linux/arm64')).toBe(false);
	});

	it('un JSON vacío no vale para ninguna plataforma', () => {
		expect(has('', 'linux/arm64')).toBe(false);
	});
});

describe('inspect_error_is_not_found y digest_from_metadata', () => {
	const notFound = (msg: string) =>
		sh(LOCAL_LIB, 'inspect_error_is_not_found "$M"', { M: msg }).code === 0;

	it('«no existe» → hay que construir; credenciales o red NO lo son: el deploy para', () => {
		expect(notFound(`ERROR: ${REG}:${SHA}: not found`)).toBe(true);
		expect(notFound('manifest unknown: manifest unknown')).toBe(true);
		expect(notFound('ERROR: failed to authorize: 401 Unauthorized')).toBe(false);
		expect(notFound('ERROR: dial tcp: lookup git.dualhand.com: no such host')).toBe(false);
	});

	it('digest_from_metadata lee containerimage.digest; sin la clave o sin fichero, falla', () => {
		const f = join(tmp, 'meta.json');
		writeFileSync(
			f,
			`{\n  "containerimage.config.digest": "sha256:${'d'.repeat(64)}",\n  "containerimage.digest": "${DIGEST_A}"\n}\n`
		);
		const r = sh(LOCAL_LIB, 'digest_from_metadata "$F"', { F: f });
		expect(r.code).toBe(0);
		expect(r.stdout.trim()).toBe(DIGEST_A);
		writeFileSync(f, `{"containerimage.config.digest": "sha256:${'d'.repeat(64)}"}`);
		expect(sh(LOCAL_LIB, 'digest_from_metadata "$F"', { F: f }).code).toBe(1);
		expect(sh(LOCAL_LIB, 'digest_from_metadata "$F"', { F: join(tmp, 'no') }).code).toBe(1);
	});
});

describe('registry_lookup', () => {
	const lookup = (env: Record<string, string>) =>
		sh(LOCAL_LIB, `registry_lookup "${REG}:x" linux/arm64`, env);

	it('existe para la plataforma → código 0 y la huella', () => {
		const r = lookup({ FAKE_DIGEST: DIGEST_A, FAKE_IMAGE_JSON: ARM64_JSON });
		expect(r.code).toBe(0);
		expect(r.stdout.trim()).toBe(DIGEST_A);
	});

	it('no existe → código 3; existe para otra plataforma → código 4', () => {
		expect(lookup({ FAKE_INSPECT_ERR: `ERROR: ${REG}:x: not found` }).code).toBe(3);
		expect(
			lookup({ FAKE_DIGEST: DIGEST_A, FAKE_IMAGE_JSON: '{"architecture":"amd64","os":"linux"}' }).code
		).toBe(4);
	});

	it('si no se puede comprobar la plataforma (falla o JSON vacío) NO se reutiliza', () => {
		const failed = lookup({ FAKE_DIGEST: DIGEST_A, FAKE_JSON_RC: '1' });
		expect(failed.code).toBe(1);
		expect(failed.stdout).toBe('');
		const empty = lookup({ FAKE_DIGEST: DIGEST_A, FAKE_IMAGE_JSON: '' });
		expect(empty.code).toBe(1);
		expect(empty.stdout).toBe('');
	});

	it('registro inaccesible → código 1 con pista de login y sin vía alternativa', () => {
		const r = lookup({ FAKE_INSPECT_ERR: 'ERROR: 401 Unauthorized' });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('docker login git.dualhand.com');
		expect(r.stderr).not.toContain('--sin-registro --');
	});

	it('una huella con formato raro no se da por buena', () => {
		expect(lookup({ FAKE_DIGEST: 'sha256:corta', FAKE_IMAGE_JSON: ARM64_JSON }).code).toBe(1);
	});
});

/**
 * Repo temporal con un remoto «origin» desnudo y `main` empujada. Copia los
 * scripts de deploy REALES, un submódulo (vendor/hebra, vendor/jdex-manager) y
 * `node_modules/` para el gate falso.
 */
function makeRepo(): string {
	const remote = join(tmp, 'remote.git');
	const work = join(tmp, 'work');
	sh(LOCAL_LIB, `git init -q --bare -b main "${remote}" && git init -q -b main "${work}"`);
	mkdirSync(join(work, 'deploy', 'lib'), { recursive: true });
	copyFileSync(join(ROOT, 'deploy', 'publicar.sh'), join(work, 'deploy', 'publicar.sh'));
	for (const f of ['deploy-registro.sh', 'remote-release.sh', 'docker-platform.sh']) {
		copyFileSync(join(ROOT, 'deploy', 'lib', f), join(work, 'deploy', 'lib', f));
	}
	writeFileSync(join(work, 'deploy', 'compose.yml'), COMPOSE);
	writeFileSync(join(work, '.gitignore'), 'node_modules\ndist/\n');
	mkdirSync(join(work, 'node_modules'));
	const git = (args: string) => sh(LOCAL_LIB, `git ${args}`, {}, work);
	// Dos submódulos como los reales (vendor/hebra, vendor/jdex-manager), con
	// origen local; `protocol.file.allow` porque git lo bloquea por defecto.
	for (const name of ['hebra', 'jdex-manager']) {
		const src = join(tmp, `sub-${name}`);
		sh(LOCAL_LIB, `git init -q -b main "${src}" && git -C "${src}" commit -q --allow-empty -m sub`);
		git(`-c protocol.file.allow=always submodule add -q "${src}" vendor/${name}`);
	}
	git('add -A');
	git('commit -qm uno');
	git(`remote add origin "${remote}"`);
	git('push -q origin main');
	return work;
}

describe('árbol limpio y HEAD en origin/main', () => {
	let work: string;
	const git = (args: string) => sh(LOCAL_LIB, `git ${args}`, {}, work);

	beforeEach(() => {
		work = makeRepo();
	});

	it('árbol limpio pasa; un fichero sin seguimiento o un cambio lo para', () => {
		expect(sh(LOCAL_LIB, 'deploy_require_clean_tree', {}, work).code).toBe(0);
		writeFileSync(join(work, 'nuevo.txt'), 'x\n');
		const r = sh(LOCAL_LIB, 'deploy_require_clean_tree', {}, work);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('nuevo.txt');
	});

	it('HEAD en origin/main pasa; sin empujar, o empujado a otra rama, lo para', () => {
		expect(sh(LOCAL_LIB, 'deploy_require_head_on_main origin main', {}, work).code).toBe(0);
		git('checkout -qb rama');
		writeFileSync(join(work, 'deploy', 'a.txt'), 'b\n');
		git('add -A');
		git('commit -qm dos');
		expect(sh(LOCAL_LIB, 'deploy_require_head_on_main origin main', {}, work).code).toBe(1);
		git('push -q origin rama');
		const r = sh(LOCAL_LIB, 'deploy_require_head_on_main origin main', {}, work);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('no está en origin/main');
	});

	it('si el fetch falla, para (no hay vía de emergencia)', () => {
		git('remote set-url origin /no/existe.git');
		const r = sh(LOCAL_LIB, 'deploy_require_head_on_main origin main', {}, work);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('no se pudo hacer git fetch');
	});
});

describe('publicar.sh de punta a punta (docker, ssh, npm y node falsos)', () => {
	let work: string;
	let head: string;
	const ssh = () => lines(`${fakeLog}.ssh`);
	const sentScript = () =>
		existsSync(`${fakeLog}.ssh.stdin`) ? readFileSync(`${fakeLog}.ssh.stdin`, 'utf8') : '';
	const deploy = (args: string[], env: Record<string, string> = {}): Run => {
		const r = spawnSync('bash', ['deploy/publicar.sh', ...args], {
			cwd: work,
			encoding: 'utf8',
			env: baseEnv({
				DOCKER_PLATFORM: 'linux/arm64',
				FAKE_DIGEST: DIGEST_A,
				FAKE_BUILD_DIGEST: DIGEST_A,
				FAKE_IMAGE_JSON: ARM64_JSON,
				...env
			})
		});
		return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
	};
	const missing = () => ({ FAKE_MISSING: `${REG}:${head}` });
	const built = () => dockerCalls().some((c) => c.startsWith('buildx build'));

	beforeEach(() => {
		work = makeRepo();
		head = sh(LOCAL_LIB, 'git rev-parse HEAD', {}, work).stdout.trim();
	});

	it('con el gate en ROJO no construye, no sube y no despliega', () => {
		const r = deploy([], { ...missing(), FAKE_GATE_RC: '1' });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain('gate en rojo');
		expect(lines(`${fakeLog}.gate`)).toHaveLength(1);
		expect(built()).toBe(false);
		expect(ssh()).toEqual([]);
	});

	it('control: con el gate en verde construye con --metadata-file, sube y despliega esa huella', () => {
		const r = deploy([], missing());
		expect(r.code, r.stderr).toBe(0);
		const build = dockerCalls().find((c) => c.startsWith('buildx build'));
		expect(build).toMatch(
			new RegExp(
				`--platform linux/arm64 --label org.opencontainers.image.revision=${head} --build-arg BASE_REGISTRY=git.dualhand.com/fodaveg/espejo --metadata-file .* -f deploy/Dockerfile -t ${REG}:${head} --push \\.$`
			)
		);
		expect(lines(`${fakeLog}.node`)).toEqual(expect.arrayContaining(['npm run check', 'npm run build']));
		expect(ssh()).toEqual(['lumbre-arm bash -s']);
		expect(sentScript()).toContain(
			`release_main apply /srv/hebra-mcp/deploy mcp ${VAR} ${REF_A} ${head} desplegar`
		);
		expect(sentScript()).toContain('release_compose_content()');
		expect(sentScript()).toContain(`RELEASE_SECRETS_ENV=${SECRETS}`);
		expect(sentScript()).toContain('RELEASE_CONTAINER=hebra-mcp');
		expect(sentScript()).toContain("RELEASE_LOG_DIR=''");
	});

	it('si la imagen ya está en el registro, no hay gate ni build', () => {
		const r = deploy([]);
		expect(r.code, r.stderr).toBe(0);
		expect(r.stdout).toContain('se REUTILIZA');
		expect(lines(`${fakeLog}.gate`)).toEqual([]);
		expect(built()).toBe(false);
		expect(sentScript()).toContain(`release_main apply /srv/hebra-mcp/deploy mcp ${VAR} ${REF_A}`);
	});

	it('registro sin credenciales o caído: para ANTES del gate y sin desplegar', () => {
		const r = deploy([], { FAKE_INSPECT_ERR: 'ERROR: 401 Unauthorized' });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain('docker login git.dualhand.com');
		expect(lines(`${fakeLog}.gate`)).toEqual([]);
		expect(built()).toBe(false);
		expect(ssh()).toEqual([]);
	});

	it('si no se puede comprobar la plataforma de la imagen del registro, para sin desplegar', () => {
		const r = deploy([], { FAKE_JSON_RC: '1' });
		expect(r.code).not.toBe(0);
		expect(ssh()).toEqual([]);
	});

	it('la imagen del registro para otra arquitectura no se reutiliza ni se pisa: para', () => {
		const r = deploy([], { FAKE_IMAGE_JSON: '{"architecture":"amd64","os":"linux"}' });
		expect(r.code).not.toBe(0);
		expect(built()).toBe(false);
		expect(ssh()).toEqual([]);
	});

	it('un HEAD fuera de origin/main no llega ni al gate', () => {
		sh(LOCAL_LIB, 'git checkout -qb rama && git commit -q --allow-empty -m x', {}, work);
		const r = deploy([], missing());
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain('no está en origin/main');
		expect(lines(`${fakeLog}.gate`)).toEqual([]);
		expect(ssh()).toEqual([]);
	});

	it('un árbol sucio no llega ni al gate', () => {
		writeFileSync(join(work, 'sucio.txt'), 'x\n');
		const r = deploy([], missing());
		expect(r.code).not.toBe(0);
		expect(lines(`${fakeLog}.gate`)).toEqual([]);
		expect(ssh()).toEqual([]);
	});

	/** Un commit local, sin empujar, que cambia el compose.yml (HEAD ≠ origin/main). */
	const commitComposeOnlyInHead = () => {
		sh(LOCAL_LIB, 'git checkout -qb rama', {}, work);
		writeFileSync(join(work, 'deploy', 'compose.yml'), `${COMPOSE}# SOLO-EN-HEAD\n`);
		sh(LOCAL_LIB, 'git commit -qam "compose sin publicar"', {}, work);
	};

	it('un deploy normal sube el compose.yml de HEAD (que está en origin/main)', () => {
		const r = deploy([]);
		expect(r.code, r.stderr).toBe(0);
		expect(sentScript()).toContain(
			"release_compose_content() {\n  cat <<'__DEPLOY_COMPOSE_FIN__'\n"
		);
		expect(sentScript()).toContain(`image: '\${${VAR}:-hebra-mcp:latest}'`);
	});

	it('--anterior sube el compose.yml de origin/main, no el de HEAD ni el del árbol, sin gate ni build', () => {
		commitComposeOnlyInHead();
		writeFileSync(join(work, 'deploy', 'compose.yml'), `${COMPOSE}# SUCIO\n`);
		const r = deploy(['--anterior']);
		expect(r.code, r.stderr).toBe(0);
		expect(sentScript()).toContain(`release_main anterior /srv/hebra-mcp/deploy mcp ${VAR}`);
		expect(sentScript()).not.toContain('SUCIO');
		expect(sentScript()).not.toContain('SOLO-EN-HEAD');
		expect(lines(`${fakeLog}.gate`)).toEqual([]);
		expect(built()).toBe(false);
	});

	it('--version <sha> despliega la huella que el registro tiene para ese commit, sin gate ni build', () => {
		commitComposeOnlyInHead();
		const r = deploy(['--version', head]);
		expect(r.code, r.stderr).toBe(0);
		expect(sentScript()).toContain(
			`release_main apply /srv/hebra-mcp/deploy mcp ${VAR} ${REF_A} ${head} version`
		);
		expect(sentScript()).not.toContain('SOLO-EN-HEAD');
		expect(lines(`${fakeLog}.gate`)).toEqual([]);
		expect(built()).toBe(false);
	});

	it('--version de un commit que no está en el registro falla y NO construye', () => {
		const r = deploy(['--version', head], missing());
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain('no está en el registro');
		expect(built()).toBe(false);
		expect(ssh()).toEqual([]);
	});

	it('--historial solo lee del server', () => {
		const r = deploy(['--historial']);
		expect(r.code, r.stderr).toBe(0);
		expect(sentScript()).toContain('release_main historial /srv/hebra-mcp/deploy mcp');
		expect(lines(`${fakeLog}.gate`)).toEqual([]);
	});

	it('--dry-run no toca el server ni el registro (salvo leer)', () => {
		const r = deploy(['--dry-run'], missing());
		expect(r.code, r.stderr).toBe(0);
		expect(r.stdout).toContain('ENSAYO EN SECO');
		expect(built()).toBe(false);
		expect(dockerCalls().some((c) => c.startsWith('push'))).toBe(false);
		expect(sentScript()).not.toContain('release_main apply');
		expect(lines(`${fakeLog}.gate`)).toEqual([]);
	});

	it('el build usa deploy/Dockerfile y deja dist/ ANTES de subir; sin dist/cli.mjs no sube', () => {
		const ok = deploy([], missing());
		expect(ok.code, ok.stderr).toBe(0);
		const calls = lines(`${fakeLog}.node`);
		expect(calls.indexOf('npm run check')).toBeLessThan(calls.indexOf('npm run build'));
		expect(existsSync(join(work, 'dist', 'cli.mjs'))).toBe(true);

		rmSync(join(work, 'dist'), { recursive: true });
		rmSync(`${fakeLog}.node`);
		writeFileSync(fakeLog, '');
		const r = deploy([], { ...missing(), FAKE_NO_DIST: '1' });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain('dist/cli.mjs');
		expect(built()).toBe(false);
	});

	it('submódulos sin inicializar: para antes del gate, aunque el árbol esté limpio', () => {
		sh(LOCAL_LIB, 'git submodule deinit -q -f vendor/hebra', {}, work);
		expect(sh(LOCAL_LIB, 'git status --porcelain', {}, work).stdout.trim()).toBe('');
		const r = deploy([], missing());
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain('submódulos no están en los commits fijados');
		expect(r.stderr).toContain('git submodule update --init');
		expect(lines(`${fakeLog}.gate`)).toEqual([]);
		expect(built()).toBe(false);
		expect(ssh()).toEqual([]);
	});

	it('un submódulo en otro commit que el fijado no se despliega (árbol sucio, no llega al gate)', () => {
		sh(LOCAL_LIB, 'git commit -q --allow-empty -m otro', {}, join(work, 'vendor', 'hebra'));
		const r = deploy([], missing());
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain('vendor/hebra');
		expect(lines(`${fakeLog}.gate`)).toEqual([]);
		expect(built()).toBe(false);
	});

	it('si la imagen ya está en el registro no exige submódulos ni Node (vale desde Fedora)', () => {
		sh(LOCAL_LIB, 'git submodule deinit -q -f vendor/hebra', {}, work);
		const r = deploy([]);
		expect(r.code, r.stderr).toBe(0);
		expect(built()).toBe(false);
	});

	it('un SSH_HOST o una ruta inválidos abortan antes de tocar docker o ssh', () => {
		const cases: Record<string, string>[] = [
			{ SSH_HOST: '-oProxyCommand=evil' },
			{ SSH_HOST: 'lumbre;rm -rf /' },
			{ REMOTE_DIR: '/srv/../etc' },
			{ HEBRA_MCP_ENV_FILE: '/srv//x.env' },
			{ HEBRA_MCP_ENV_FILE: 'relativa' }
		];
		for (const env of cases) {
			const r = deploy([], env);
			expect(r.code, JSON.stringify(env)).toBe(1);
			expect(dockerCalls(), JSON.stringify(env)).toEqual([]);
			expect(ssh(), JSON.stringify(env)).toEqual([]);
		}
	});
});

describe('remote-release: .env e historial', () => {
	const envFile = () => join(tmp, 'srv', '.env');

	it('env_set sustituye la clave, conserva las demás y la borra con valor vacío', () => {
		writeFileSync(envFile(), `OTRA=1\n${VAR}=vieja\n`);
		sh(REMOTE_LIB, `env_set "$F" ${VAR} "${REF_A}"`, { F: envFile() });
		expect(readFileSync(envFile(), 'utf8')).toBe(`OTRA=1\n${VAR}=${REF_A}\n`);
		expect(sh(REMOTE_LIB, `env_get "$F" ${VAR}`, { F: envFile() }).stdout.trim()).toBe(REF_A);
		sh(REMOTE_LIB, `env_set "$F" ${VAR} ""`, { F: envFile() });
		expect(readFileSync(envFile(), 'utf8')).toBe('OTRA=1\n');
	});

	it('env_set conserva los permisos del .env (y crea uno nuevo con 644)', () => {
		sh(REMOTE_LIB, `env_set "$F" ${VAR} "${REF_A}"`, { F: envFile() });
		expect(statSync(envFile()).mode & 0o777).toBe(0o644);
		chmodSync(envFile(), 0o600);
		sh(REMOTE_LIB, `env_set "$F" ${VAR} "${REF_B}"`, { F: envFile() });
		expect(statSync(envFile()).mode & 0o777).toBe(0o600);
	});

	it('ref_needs_pull: solo las referencias por huella se bajan del registro', () => {
		expect(sh(REMOTE_LIB, `ref_needs_pull "${REF_A}"`).code).toBe(0);
		expect(sh(REMOTE_LIB, 'ref_needs_pull hebra-mcp:previo-registro').code).toBe(1);
		expect(sh(REMOTE_LIB, `ref_needs_pull ${REG}:${SHA}`).code).toBe(1);
	});

	it('historial: el anterior sale de la línea cuya imagen nueva es la actual, sin las fallidas', () => {
		const log = join(tmp, 'srv', 'despliegues.log');
		sh(
			REMOTE_LIB,
			`release_history_append "$L" mcp desplegar ${SHA} "${REF_A}" hebra-mcp:previo-registro ""
release_history_append "$L" mcp desplegar-fallido bbbbbbb "${REF_B}" "${REF_A}" ""`,
			{ L: log }
		);
		const ls = lines(log);
		expect(ls).toHaveLength(2);
		expect(ls[0].split('\t')).toEqual([
			expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
			'mcp',
			'desplegar',
			SHA,
			REF_A,
			'hebra-mcp:previo-registro',
			'-'
		]);
		const prev = (ref: string) => sh(REMOTE_LIB, `release_previous_ref "$L" mcp "${ref}"`, { L: log });
		expect(prev(REF_A).stdout.trim()).toBe('hebra-mcp:previo-registro');
		expect(prev(REF_B).code).toBe(1); // solo aparece en una línea fallida
	});
});

describe('remote-release: release_apply y release_rollback', () => {
	const srv = () => join(tmp, 'srv');
	const env = () => readFileSync(join(srv(), '.env'), 'utf8');
	const history = () => lines(join(srv(), 'despliegues.log'));
	const common = { RELEASE_CONTAINER: 'hebra-mcp', RELEASE_IMAGE_VAR: VAR };
	const apply = (ref: string, e: Record<string, string> = {}, sha = SHA) =>
		sh(REMOTE_LIB, `release_apply "$D" mcp ${VAR} "${ref}" ${sha} desplegar`, {
			D: srv(),
			...common,
			...e
		});
	const rollback = (e: Record<string, string> = {}) =>
		sh(REMOTE_LIB, `release_rollback "$D" mcp ${VAR}`, { D: srv(), ...common, ...e });
	const ups = () => dockerCalls().filter((c) => c.startsWith('compose up'));
	const RUNNING = 'hebra-mcp:latest sha256:4d1f436f2d78 5b7b732c23a87aefeec24c877736d3107bbb2b6b8e93';

	it('primer despliegue: guarda la imagen que corría como previo-registro y baja antes de tocar el .env', () => {
		const r = apply(REF_A, { FAKE_CONTAINER: RUNNING });
		expect(r.code, r.stderr).toBe(0);
		expect(env()).toBe(`${VAR}=${REF_A}\n`);
		const calls = dockerCalls();
		expect(calls).toContain('tag sha256:4d1f436f2d78 hebra-mcp:previo-registro');
		const pull = calls.indexOf(`pull ${REF_A}`);
		const up = calls.indexOf('compose up -d --wait --wait-timeout 120 mcp');
		expect(pull).toBeGreaterThan(-1);
		expect(up).toBeGreaterThan(pull);
		const fields = history()[0].split('\t');
		expect(fields.slice(1, 6)).toEqual(['mcp', 'desplegar', SHA, REF_A, 'hebra-mcp:previo-registro']);
		expect(fields[6]).toBe(
			'previo=hebra-mcp:latest imagen=sha256:4d1f436f2d78 contenedor=5b7b732c23a8'
		);
		// La salida de docker va al log del server, no al SSH.
		expect(readFileSync(join(srv(), 'despliegues-compose.log'), 'utf8')).toContain(
			`docker pull ${REF_A}`
		);
	});

	it('compose recibe la imagen por huella en el ENTORNO y los secretos con --env-file', () => {
		const r = apply(REF_A, { FAKE_CONTAINER: RUNNING, RELEASE_SECRETS_ENV: SECRETS });
		expect(r.code, r.stderr).toBe(0);
		const composeCalls = lines(`${fakeLog}.compose`);
		const up = composeCalls.find((c) => c.includes(':: compose up'));
		expect(up).toBe(
			`env-file=[${SECRETS}] imagen=[${REF_A}] :: compose up -d --wait --wait-timeout 120 mcp`
		);
	});

	it('sin RELEASE_SECRETS_ENV no pasa --env-file', () => {
		apply(REF_A, { FAKE_CONTAINER: RUNNING });
		expect(lines(`${fakeLog}.compose`).every((c) => c.startsWith('env-file=[]'))).toBe(true);
	});

	it('vuelca el log del saliente (parándolo antes) solo con RELEASE_LOG_DIR', () => {
		const logDir = join(tmp, 'logs');
		const r = apply(REF_A, {
			FAKE_CONTAINER: RUNNING,
			FAKE_REV: SHA,
			RELEASE_LOG_DIR: logDir
		});
		expect(r.code, r.stderr).toBe(0);
		const calls = dockerCalls();
		const stop = calls.indexOf('stop -t 15 hebra-mcp');
		expect(stop).toBeGreaterThan(-1);
		expect(calls.indexOf('logs --timestamps hebra-mcp')).toBeGreaterThan(stop);
		expect(calls.indexOf('compose up -d --wait --wait-timeout 120 mcp')).toBeGreaterThan(stop);
		const files = readdirSync(logDir);
		expect(files.some((f) => new RegExp(`-saliente-${SHA.slice(0, 12)}\\.log\\.gz$`).test(f))).toBe(
			true
		);

		rmSync(fakeLog);
		rmSync(join(srv(), '.env'));
		apply(REF_B, { FAKE_CONTAINER: RUNNING }, 'bbbbbbbbbbbb');
		expect(dockerCalls().some((c) => c.startsWith('stop'))).toBe(false);
	});

	it('la misma imagen otra vez: no baja, no escribe historial', () => {
		apply(REF_A, { FAKE_CONTAINER: RUNNING });
		rmSync(fakeLog);
		const r = apply(REF_A);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain('sin cambiar nada');
		expect(dockerCalls().some((c) => c.startsWith('pull'))).toBe(false);
		expect(history()).toHaveLength(1);
	});

	it('el .env ya apunta a la imagen pero el historial no (sesión cortada): reconcilia', () => {
		apply(REF_A, { FAKE_CONTAINER: RUNNING });
		writeFileSync(join(srv(), '.env'), `${VAR}=${REF_B}\n`);
		const r = apply(REF_B, {}, 'bbbbbbbbbbbb');
		expect(r.code, r.stderr).toBe(0);
		expect(history()[1].split('\t').slice(2, 6)).toEqual(['reconciliar', 'bbbbbbbbbbbb', REF_B, REF_A]);
		expect(rollback().code).toBe(0);
		expect(env()).toBe(`${VAR}=${REF_A}\n`);
	});

	it('si no se puede bajar y no está en el server, no toca el .env', () => {
		apply(REF_A, { FAKE_CONTAINER: RUNNING });
		const r = apply(REF_B, { FAKE_PULL_RC: '1' });
		expect(r.code).toBe(1);
		expect(env()).toBe(`${VAR}=${REF_A}\n`);
		expect(history()).toHaveLength(1);
	});

	it('con el registro caído vale una huella que ya está en el server', () => {
		apply(REF_A, { FAKE_CONTAINER: RUNNING });
		const r = apply(REF_B, { FAKE_PULL_RC: '1', FAKE_LOCAL_IMAGES: REF_B });
		expect(r.code, r.stderr).toBe(0);
		expect(env()).toBe(`${VAR}=${REF_B}\n`);
	});

	it('si compose falla, restaura el valor anterior, vuelve a levantar y apunta el fallo', () => {
		apply(REF_A, { FAKE_CONTAINER: RUNNING });
		rmSync(`${fakeLog}.up`);
		const r = apply(REF_B, { FAKE_UP_RC: '1' });
		expect(r.code).toBe(1);
		expect(env()).toBe(`${VAR}=${REF_A}\n`);
		expect(ups().length).toBe(3);
		expect(history()[1].split('\t')[2]).toBe('desplegar-fallido');
	});

	it('un contenedor que no se queda en marcha (reinicios) cuenta como fallo y se restaura', () => {
		apply(REF_A, { FAKE_CONTAINER: RUNNING });
		const r = apply(REF_B, { FAKE_STATE: 'true 3' });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('no se queda en marcha');
		expect(env()).toBe(`${VAR}=${REF_A}\n`);
		expect(history()[1].split('\t')[2]).toBe('desplegar-fallido');
	});

	it('se niega con un compose.yml que no lee la variable (ignoraría el .env)', () => {
		writeFileSync(join(srv(), 'compose.yml'), 'services:\n  mcp:\n    image: hebra-mcp:latest\n');
		const r = apply(REF_A, { FAKE_CONTAINER: RUNNING });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(`no lee \${${VAR}}`);
		expect(existsSync(join(srv(), '.env'))).toBe(false);
	});

	it('--anterior vuelve a la imagen previa y dos seguidas alternan', () => {
		apply(REF_A, { FAKE_CONTAINER: RUNNING });
		apply(REF_B, {}, 'bbbbbbbbbbbb');
		const back = () => rollback({ FAKE_LOCAL_IMAGES: 'hebra-mcp:previo-registro' });
		expect(back().code).toBe(0);
		expect(env()).toBe(`${VAR}=${REF_A}\n`);
		expect(history()[2].split('\t').slice(2, 6)).toEqual(['anterior', SHA, REF_A, REF_B]);
		expect(back().code).toBe(0);
		expect(env()).toBe(`${VAR}=${REF_B}\n`);
	});

	it('--anterior con el historial desincronizado del .env falla sin tocar nada', () => {
		apply(REF_A, { FAKE_CONTAINER: RUNNING });
		writeFileSync(join(srv(), '.env'), `${VAR}=${REF_B}\n`);
		const r = rollback({ FAKE_LOCAL_IMAGES: 'hebra-mcp:previo-registro' });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('historial desincronizado');
		expect(env()).toBe(`${VAR}=${REF_B}\n`);
	});

	it('--anterior a la imagen previa al registro funciona si sigue en el server; si no, falla y dice qué hacer', () => {
		apply(REF_A, { FAKE_CONTAINER: RUNNING });
		let r = rollback();
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('ya no está en el server');
		expect(r.stderr).toContain('--version');
		expect(env()).toBe(`${VAR}=${REF_A}\n`);

		r = rollback({ FAKE_LOCAL_IMAGES: 'hebra-mcp:previo-registro' });
		expect(r.code, r.stderr).toBe(0);
		expect(env()).toBe(`${VAR}=hebra-mcp:previo-registro\n`);
		expect(dockerCalls().some((c) => c === 'pull hebra-mcp:previo-registro')).toBe(false);
	});

	it('--anterior sin imagen en el .env falla', () => {
		const r = rollback();
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('aún no se ha desplegado por registro');
	});

	it('tras desplegar retira <contenedor>:latest si es la misma imagen que :previo-registro', () => {
		const r = apply(REF_A, {
			FAKE_CONTAINER: RUNNING,
			FAKE_LOCAL_IMAGES: 'hebra-mcp:latest=sha256:old hebra-mcp:previo-registro=sha256:old'
		});
		expect(r.code, r.stderr).toBe(0);
		expect(dockerCalls()).toContain('image rm hebra-mcp:latest');
	});

	it('release_main instala el compose.yml recibido antes de desplegar', () => {
		writeFileSync(join(srv(), 'compose.yml'), 'services: {}\n');
		const r = sh(
			REMOTE_LIB,
			`release_compose_content() { printf '%s' "$C"; }
release_main apply "$D" mcp ${VAR} "${REF_A}" ${SHA} desplegar`,
			{ D: srv(), C: COMPOSE, FAKE_CONTAINER: RUNNING }
		);
		expect(r.code, r.stderr).toBe(0);
		expect(readFileSync(join(srv(), 'compose.yml'), 'utf8')).toBe(COMPOSE);
		expect(existsSync(join(srv(), 'compose.yml.nuevo'))).toBe(false);
	});

	it('un compose.yml recibido que no lee la variable no se instala (se valida antes del mv)', () => {
		const r = sh(
			REMOTE_LIB,
			`release_compose_content() { printf '%s' "$C"; }
release_main apply "$D" mcp ${VAR} "${REF_A}" ${SHA} desplegar`,
			{ D: srv(), C: 'services:\n  mcp:\n    image: hebra-mcp:latest\n', FAKE_CONTAINER: RUNNING }
		);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(`no lee \${${VAR}}`);
		expect(readFileSync(join(srv(), 'compose.yml'), 'utf8')).toBe(COMPOSE);
		expect(existsSync(join(srv(), 'compose.yml.nuevo'))).toBe(false);
		expect(existsSync(join(srv(), '.env'))).toBe(false);
		expect(dockerCalls().some((c) => c.startsWith('pull') || c.startsWith('compose up -d'))).toBe(false);
	});

	it('si compose no acepta --wait-timeout, release_main para sin tocar nada', () => {
		writeFileSync(join(srv(), 'compose.yml'), 'services: {}\n');
		const r = sh(
			REMOTE_LIB,
			`release_compose_content() { printf '%s' "$C"; }
release_main apply "$D" mcp ${VAR} "${REF_A}" ${SHA} desplegar`,
			{ D: srv(), C: COMPOSE, FAKE_CONTAINER: RUNNING, FAKE_COMPOSE_HELP: '      --wait   Wait' }
		);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('--wait-timeout');
		expect(readFileSync(join(srv(), 'compose.yml'), 'utf8')).toBe('services: {}\n');
		expect(existsSync(join(srv(), '.env'))).toBe(false);
	});

	it('con RELEASE_SECRETS_ENV ausente o con permisos distintos de 0600, release_main para sin tocar nada', () => {
		const secrets = join(tmp, 'secretos.env');
		const run = () =>
			sh(REMOTE_LIB, `release_main apply "$D" mcp ${VAR} "${REF_A}" ${SHA} desplegar`, {
				D: srv(),
				...common,
				RELEASE_SECRETS_ENV: secrets,
				FAKE_CONTAINER: RUNNING
			});
		let r = run();
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('falta');
		writeFileSync(secrets, 'HEBRA_MCP_BACKCHANNEL_SECRET=x\n');
		chmodSync(secrets, 0o640);
		r = run();
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('0600');
		expect(existsSync(join(srv(), '.env'))).toBe(false);
		expect(dockerCalls().some((c) => c.startsWith('pull') || c.startsWith('compose up -d'))).toBe(false);
		chmodSync(secrets, 0o600);
		expect(run().code).toBe(0);
	});

	it('release_main deja el log de docker en sus últimas 5000 líneas', () => {
		const out = join(srv(), 'despliegues-compose.log');
		writeFileSync(out, Array.from({ length: 6000 }, (_, i) => `línea ${i}`).join('\n') + '\n');
		const r = sh(REMOTE_LIB, `release_main apply "$D" mcp ${VAR} "${REF_A}" ${SHA} desplegar`, {
			D: srv(),
			FAKE_CONTAINER: RUNNING
		});
		expect(r.code, r.stderr).toBe(0);
		const ls = lines(out);
		expect(ls).toHaveLength(5000);
		expect(ls).not.toContain('línea 0');
	});
});
