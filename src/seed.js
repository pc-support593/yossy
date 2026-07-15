require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

const users = [
  { email: 'applicant@example.com', password: 'password123', name: '一般一郎', department: '総務', company: '㈱ゆめすみか', role: 'applicant' },
  { email: 'supervisor@example.com', password: 'password123', name: '上長二郎', department: '総務', company: '㈱ゆめすみか', role: 'supervisor' },
  { email: 'accounting@example.com', password: 'password123', name: '経理三郎', department: '経理', company: '㈱ゆめすみか', role: 'accounting' },
];

const insert = db.prepare(`
  INSERT INTO users (email, password_hash, name, department, company, role)
  VALUES (@email, @password_hash, @name, @department, @company, @role)
  ON CONFLICT(email) DO UPDATE SET
    name = excluded.name,
    department = excluded.department,
    company = excluded.company,
    role = excluded.role
`);

for (const u of users) {
  const password_hash = bcrypt.hashSync(u.password, 10);
  insert.run({
    email: u.email,
    password_hash,
    name: u.name,
    department: u.department,
    company: u.company,
    role: u.role,
  });
}

console.log('シードユーザーを作成しました:');
for (const u of users) {
  console.log(`  ${u.email} / ${u.password} (${u.role})`);
}
