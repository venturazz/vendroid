// pm2 alternative to systemd:  pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup
// Load the env file first, e.g.:  set -a; . /etc/android-runner.env; set +a; pm2 start ...
module.exports = {
  apps: [{
    name: 'android-runner',
    script: '/opt/android-runner/src/server.js',
    cwd: '/opt/android-runner',
    exec_mode: 'fork',
    instances: 1,                 // single instance: the build lock is in-process
    autorestart: true,
    kill_timeout: 30000,
    max_memory_restart: '1G',     // the runner itself is tiny; Gradle runs in child processes
  }],
};
