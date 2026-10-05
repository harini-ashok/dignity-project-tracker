// Keeps sign-ins in a small JSON file next to the workbook, so restarting the
// app (or cPanel recycling it) doesn't sign everyone out.
const fs = require('fs');
const session = require('express-session');

class FileStore extends session.Store {
  constructor(file) {
    super();
    this.file = file;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    this.timer = null;
    this.prune();
  }

  prune() {
    const now = Date.now();
    for (const [sid, s] of Object.entries(this.data)) {
      const exp = s.cookie && s.cookie.expires ? new Date(s.cookie.expires).getTime() : 0;
      if (exp && exp < now) delete this.data[sid];
    }
  }

  save() {
    // Batch writes: many requests touch the session in quick succession.
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.prune();
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    }, 200);
    this.timer.unref();
  }

  get(sid, cb) { cb(null, this.data[sid] || null); }
  set(sid, sess, cb) { this.data[sid] = JSON.parse(JSON.stringify(sess)); this.save(); cb && cb(null); }
  destroy(sid, cb) { delete this.data[sid]; this.save(); cb && cb(null); }
  touch(sid, sess, cb) { if (this.data[sid]) { this.data[sid].cookie = sess.cookie; this.save(); } cb && cb(null); }
}

module.exports = { FileStore };
