import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Configuración del despliegue: compose.yml, Dockerfile, .dockerignore y las
// constantes de deploy/publicar.sh. El comportamiento del despliegue por
// registro (huella, vuelta atrás, orden de los pasos) se prueba en
// `deploy-registro.test.ts` con dobles de docker y ssh.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

describe('publicar.sh: constantes que tienen que casar con compose.yml y el registro', () => {
  it('servicio, contenedor, variable de imagen y nombre en el registro', () => {
    const publish = read('deploy/publicar.sh');
    const compose = read('deploy/compose.yml');
    expect(publish).toContain('DEPLOY_SERVICE="mcp"');
    expect(compose).toMatch(/^ {2}mcp:$/m);
    expect(publish).toContain('DEPLOY_CONTAINER="hebra-mcp"');
    expect(compose).toMatch(/^ {4}container_name: hebra-mcp$/m);
    expect(publish).toContain('DEPLOY_ENV_VAR="HEBRA_MCP_IMAGE"');
    expect(compose).toContain('image: ${HEBRA_MCP_IMAGE:-hebra-mcp:latest}');
    expect(publish).toContain('DEPLOY_IMAGE="hebra-mcp"');
    expect(publish).toContain('DEPLOY_DOCKERFILE="deploy/Dockerfile"');
  });

  it('los secretos del server siguen en deploy/.env (0600), fuera de lo que escribe el deploy', () => {
    const publish = read('deploy/publicar.sh');
    expect(publish).toContain('DEPLOY_SECRETS_ENV="${HEBRA_MCP_ENV_FILE:-$REMOTE_DIR/.env}"');
    expect(read('deploy/lib/remote-release.sh')).toContain('args=(--env-file "$RELEASE_SECRETS_ENV")');
    // Compose sigue exigiendo el secreto y el directorio del volumen cifrado.
    const compose = read('deploy/compose.yml');
    expect(compose).toContain('${HEBRA_MCP_BACKCHANNEL_SECRET:?');
    expect(compose).toContain('${HEBRA_MCP_DATA_DEVICE:?');
  });

  it('ya no copia el árbol por rsync ni construye en el server', () => {
    for (const file of ['deploy/publicar.sh', 'deploy/lib/deploy-registro.sh', 'deploy/lib/remote-release.sh']) {
      const text = read(file);
      expect(text, file).not.toMatch(/\brsync\b.*(--delete|-rlptz)/);
      expect(text, file).not.toContain('compose build');
      expect(text, file).not.toContain('--build');
    }
    expect(read('deploy/compose.yml')).not.toMatch(/^ {4}build:/m);
  });

  it('el build parte de los submódulos fijados y del gate del repo, y sube con --push + --metadata-file', () => {
    const publish = read('deploy/publicar.sh');
    expect(publish).toContain('git submodule status --recursive');
    expect(publish.indexOf('deploy_require_pinned_submodules || return 1')).toBeLessThan(
      publish.indexOf('npm run check ||')
    );
    expect(publish.indexOf('npm run check ||')).toBeLessThan(publish.indexOf('npm run build ||'));
    expect(publish).toMatch(/deploy_tag_for_commit\(\) \{\n {2}echo "\$1"\n\}/);
    const lib = read('deploy/lib/deploy-registro.sh');
    expect(lib).toContain('--push');
    expect(lib).toContain('--metadata-file');
    expect(lib).toContain('--label "org.opencontainers.image.revision=$sha"');
  });

  it('los scripts son bash válido', () => {
    for (const file of [
      'deploy/publicar.sh',
      'deploy/lib/deploy-registro.sh',
      'deploy/lib/remote-release.sh',
      'deploy/lib/docker-platform.sh'
    ]) {
      const result = spawnSync('bash', ['-n', join(ROOT, file)], { encoding: 'utf8' });
      expect(result.status, `${file}: ${result.stderr}`).toBe(0);
    }
  });
});

describe('imagen: solo lo necesario y sin secretos', () => {
  it('.dockerignore deja pasar solo package.json, package-lock.json y dist (nada de vendor/ ni .env)', () => {
    const lines = read('.dockerignore')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(lines).toEqual(['*', '!package.json', '!package-lock.json', '!dist']);
  });

  it('el Dockerfile solo copia lo que el .dockerignore deja pasar', () => {
    const copies = [...read('deploy/Dockerfile').matchAll(/^COPY (.+)$/gm)].map((m) => m[1]);
    expect(copies).toEqual(['package.json package-lock.json ./', 'dist/ ./dist/']);
  });
});
