/**
 * Kiểm thử toàn bộ API của Contests-BE với dữ liệu thật.
 *
 *   node scripts/api-test.mjs            (backend chạy ở http://localhost:3001)
 *   $env:TEST_API_URL="http://localhost:3000"; node scripts/api-test.mjs
 *
 * Script tự tạo dữ liệu riêng (gắn mã thời gian), gọi lần lượt mọi endpoint
 * bằng 3 vai trò Admin / Judge / Student, kiểm tra phân quyền, rồi dọn sạch
 * dữ liệu đã tạo. Cuối cùng in báo cáo + danh sách endpoint chưa được gọi.
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const XLSX = require("xlsx");
const { io } = require("socket.io-client");

const BASE = process.env.TEST_API_URL || "http://localhost:3001";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = new PrismaClient();
const S = String(Date.now()).slice(-7); // mã riêng cho lần chạy
const results = [];
const tested = new Set();
const created = {}; // id dữ liệu đã tạo để dọn dẹp

// ---------------------------------------------------------------- HTTP ----
class Session {
  constructor(name) {
    this.name = name;
    this.cookies = {};
  }
  cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async send(method, url, { json, form, query } = {}) {
    const u = new URL(BASE + url);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) u.searchParams.set(k, v);
    const headers = {};
    if (Object.keys(this.cookies).length) headers.Cookie = this.cookieHeader();
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form) body = form;
    const res = await fetch(u, { method, headers, body });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v) this.cookies[k] = v;
      else delete this.cookies[k];
    }
    const type = res.headers.get("content-type") || "";
    let data;
    if (type.includes("json")) data = await res.json().catch(() => null);
    else if (type.includes("text") || type.includes("html")) data = await res.text();
    else data = Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, type };
  }
}
const anon = new Session("Khách");

/**
 * Gọi một endpoint và ghi kết quả.
 * tpl: đường dẫn mẫu như trong router (vd /api/contest/:id), p: giá trị tham số.
 * expect: mã mong đợi (số, mảng) – mặc định 2xx và success !== false.
 */
async function call(sess, method, tpl, p = {}, opts = {}) {
  const url = tpl.replace(/:(\w+)/g, (_, k) => {
    if (p[k] === undefined) throw new Error(`Thiếu tham số ${k} cho ${tpl}`);
    return encodeURIComponent(p[k]);
  });
  tested.add(`${method} ${tpl}`);
  let r;
  try {
    r = await sess.send(method, url, opts);
  } catch (e) {
    r = { status: 0, data: String(e) };
  }
  const exp = opts.expect;
  let ok;
  if (exp === undefined) ok = r.status >= 200 && r.status < 300 && !(r.data && r.data.success === false);
  else ok = (Array.isArray(exp) ? exp : [exp]).includes(r.status);
  const msg = r.data && typeof r.data === "object" && !Buffer.isBuffer(r.data)
    ? r.data.message || (r.data.error && JSON.stringify(r.data.error).slice(0, 160)) || ""
    : Buffer.isBuffer(r.data) ? `${r.data.length} bytes` : String(r.data || "").slice(0, 120);
  results.push({ kind: "api", method, tpl, who: sess.name, status: r.status, ok, note: opts.note || "", msg, exp });
  const mark = ok ? "✔" : "✘";
  console.log(`${mark} ${String(r.status).padEnd(3)} ${method.padEnd(6)} ${tpl.padEnd(62)} [${sess.name}] ${ok ? "" : "→ " + msg}`);
  return r;
}
const data = r => (r && r.data && typeof r.data === "object" ? r.data.data : undefined);
const list = d => {
  if (Array.isArray(d)) return d;
  if (d && typeof d === "object") {
    for (const v of Object.values(d)) if (Array.isArray(v)) return v;
  }
  return [];
};
function check(name, cond, detail = "") {
  results.push({ kind: "check", tpl: name, ok: !!cond, msg: detail });
  console.log(`${cond ? "✔" : "✘"} KIỂM TRA  ${name} ${cond ? "" : "→ " + detail}`);
}

async function login(name, identifier, password, student = false) {
  const s = new Session(name);
  await call(s, "POST", student ? "/api/auth/student-login" : "/api/auth/login", {}, { json: { identifier, password } });
  return s;
}

// --------------------------------------------------------------- Files ----
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);
const MP4 = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex");
function xlsx(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
function form(fields, files = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, String(v));
  for (const [k, [buf, name, type]] of Object.entries(files)) f.append(k, new Blob([buf], { type }), name);
  return f;
}

// ------------------------------------------------------------ Socket -------
function connectSocket(sess, ns) {
  return new Promise(resolve => {
    const s = io(BASE + ns, {
      transports: ["websocket"],
      extraHeaders: { Cookie: sess.cookieHeader() },
      forceNew: true,
      reconnection: false,
    });
    const t = setTimeout(() => resolve({ s, ok: false, err: "timeout" }), 6000);
    s.on("connect", () => { clearTimeout(t); resolve({ s, ok: true }); });
    s.on("connect_error", e => { clearTimeout(t); resolve({ s, ok: false, err: e.message }); });
  });
}
const emit = (s, ev, payload) =>
  new Promise(resolve => {
    const t = setTimeout(() => resolve({ timeout: true }), 6000);
    s.emit(ev, payload, (...args) => {
      clearTimeout(t);
      resolve(args.find(a => a && typeof a === "object") || { args });
    });
  });

// ------------------------------------------------------------- Kịch bản ---
async function main() {
  console.log(`\n=== KIỂM THỬ API ${BASE} (mã chạy ${S}) ===\n`);
  const health = await anon.send("GET", "/health");
  if (health.status !== 200) throw new Error(`Backend không chạy ở ${BASE}`);

  // ---------- AUTH ----------
  console.log("\n--- Xác thực ---");
  await call(anon, "POST", "/api/auth/login", {}, { json: { identifier: "admin", password: "sai-mat-khau" }, expect: 400, note: "sai mật khẩu" });
  const A = await login("Admin", "admin", "admin123");
  await call(A, "GET", "/api/auth/profile");
  await call(A, "GET", "/api/auth/abc");
  await call(A, "GET", "/api/auth/admin");
  await call(A, "GET", "/api/auth/judge", {}, { expect: 403, note: "admin gọi route judge" });
  await call(A, "GET", "/api/auth/refresh-token");
  await call(anon, "GET", "/api/auth/profile", {}, { expect: 401, note: "chưa đăng nhập" });
  await call(anon, "POST", "/api/auth/student-login", {}, { json: { identifier: "admin", password: "admin123" }, expect: 400, note: "admin đăng nhập cổng thí sinh" });

  // ---------- Dữ liệu nền: trường, lớp ----------
  console.log("\n--- Trường / Lớp ---");
  await call(A, "GET", "/api/school/get-school");
  await call(A, "GET", "/api/school", {}, { query: { page: 1, limit: 5, search: "Trường" } });
  let r = await call(A, "POST", "/api/school", {}, { json: { name: `Trường Test ${S}`, email: `school${S}@test.vn`, phone: `09${S.padStart(8, "0")}`.slice(0, 10), address: "Test" } });
  const school = data(r);
  created.schools = [school?.id];
  await call(A, "GET", "/api/school/:id", { id: school.id });
  await call(A, "PATCH", "/api/school/:id", { id: school.id }, { json: { address: "Đã sửa" } });
  await call(A, "PATCH", "/api/school/:id/toggle-active", { id: school.id });
  await call(A, "PATCH", "/api/school/:id/toggle-active", { id: school.id }, { note: "bật lại" });
  r = await call(A, "POST", "/api/school", {}, { json: { name: `Trường Xoá ${S}`, email: `del${S}@test.vn`, phone: `08${S.padStart(8, "0")}`.slice(0, 10), address: "x" } });
  const school2 = data(r);

  await call(anon, "GET", "/api/class/list-with-school");
  await call(A, "GET", "/api/class/list-class");
  await call(A, "GET", "/api/class", {}, { query: { page: 1, limit: 5 } });
  r = await call(A, "POST", "/api/class", {}, { json: { name: `Lớp ${S}`, schoolId: school.id, isActive: true } });
  const cls = data(r);
  created.classes = [cls?.id];
  await call(A, "GET", "/api/class/school/:id", { id: school.id });
  await call(A, "GET", "/api/class/:id", { id: cls.id });
  await call(A, "PATCH", "/api/class/:id", { id: cls.id }, { json: { name: `Lớp ${S} sửa` } });
  await call(A, "PATCH", "/api/class/:id/toggle-active", { id: cls.id });
  await call(A, "PATCH", "/api/class/:id/toggle-active", { id: cls.id }, { note: "bật lại" });
  r = await call(A, "POST", "/api/class", {}, { json: { name: `Lớp xoá ${S}`, schoolId: school2.id, isActive: true } });
  const cls2 = data(r);
  await call(A, "DELETE", "/api/class/:id", { id: cls2.id });
  r = await call(A, "POST", "/api/class", {}, { json: { name: `Lớp xoá2 ${S}`, schoolId: school2.id, isActive: true } });
  await call(A, "POST", "/api/class/delete-many", {}, { json: { ids: [data(r).id] } });
  await call(A, "DELETE", "/api/school/:id", { id: school2.id });
  r = await call(A, "POST", "/api/school", {}, { json: { name: `Trường Xoá2 ${S}`, email: `del2${S}@test.vn`, phone: `07${S.padStart(8, "0")}`.slice(0, 10), address: "x" } });
  await call(A, "POST", "/api/school/delete-many", {}, { json: { ids: [data(r).id] } });

  // ---------- Đăng ký tài khoản ----------
  console.log("\n--- Đăng ký / tài khoản ---");
  const pw = "Test1234";
  const stu = [];
  for (let i = 1; i <= 3; i++) {
    const username = `ts${S}${i}`;
    await call(anon, "POST", "/api/auth/register-student", {}, {
      json: { username, email: `${username}@test.vn`, password: pw, confirmPassword: pw, fullName: `Thí sinh Test ${S}-${i}`, classId: cls.id },
    });
    const u = await db.user.findUnique({ where: { username }, include: { student: true } });
    stu.push({ username, userId: u?.id, studentId: u?.student?.id });
  }
  created.users = stu.map(s => s.userId);
  created.students = stu.map(s => s.studentId);
  await call(anon, "POST", "/api/auth/register-student", {}, {
    json: { username: stu[0].username, email: `x${S}@test.vn`, password: pw, confirmPassword: pw, fullName: "x", classId: cls.id },
    expect: 400, note: "trùng tên đăng nhập",
  });
  await call(anon, "POST", "/api/auth/register", {}, {
    json: { username: `rg${S}`, email: `rg${S}@test.vn`, password: pw, confirmPassword: pw, role: "Judge", isActive: true },
  });
  const rg = await db.user.findUnique({ where: { username: `rg${S}` } });
  if (rg) created.users.push(rg.id);

  // Quên mật khẩu (OTP lấy từ DB vì email có thể không gửi được)
  const fp = await call(anon, "POST", "/api/auth/forgot-password", {}, { json: { email: `rg${S}@test.vn` }, expect: [200, 400], note: "gửi email OTP" });
  const otpUser = await db.user.findUnique({ where: { username: `rg${S}` } });
  if (otpUser?.otpCode) {
    await call(anon, "POST", "/api/auth/verify-otp", {}, { json: { email: otpUser.email, otp: "000000" === otpUser.otpCode ? "111111" : "000000" }, expect: 400, note: "OTP sai" });
    await call(anon, "POST", "/api/auth/verify-otp", {}, { json: { email: otpUser.email, otp: otpUser.otpCode } });
    await call(anon, "POST", "/api/auth/reset-password", {}, { json: { email: otpUser.email, otp: otpUser.otpCode, newPassword: "Reset1234", confirmNewPassword: "Reset1234" } });
    await call(anon, "POST", "/api/auth/login", {}, { json: { identifier: `rg${S}`, password: "Reset1234" }, note: "đăng nhập bằng mật khẩu mới" });
  } else {
    check("Quên mật khẩu tạo OTP", false, `không có OTP trong DB (status ${fp.status}: ${fp.data?.message})`);
  }

  // Tài khoản trọng tài riêng cho test
  r = await call(A, "POST", "/api/user", {}, { json: { username: `jd${S}`, email: `jd${S}@test.vn`, password: "Judge1234", role: "Judge", isActive: true } });
  const judge = data(r);
  created.users.push(judge.id);
  const J = await login("Judge", `jd${S}`, "Judge1234");
  await call(J, "GET", "/api/auth/judge");
  await call(J, "GET", "/api/auth/admin", {}, { expect: 403, note: "judge gọi route admin" });

  // ---------- Người dùng ----------
  console.log("\n--- Người dùng ---");
  await call(A, "GET", "/api/user/get-user");
  await call(A, "GET", "/api/user/get-student");
  await call(A, "GET", "/api/user/get-student/:userId", { userId: stu[0].userId });
  await call(A, "GET", "/api/user", {}, { query: { page: 1, limit: 5, role: "Judge" } });
  await call(A, "GET", "/api/user/:id", { id: judge.id });
  await call(A, "PATCH", "/api/user/:id", { id: judge.id }, { json: { email: `jd${S}b@test.vn` } });
  await call(A, "PATCH", "/api/user/:id/toggle-active", { id: rg.id });
  await call(A, "PATCH", "/api/user/:id/toggle-active", { id: rg.id }, { note: "bật lại" });
  r = await call(A, "POST", "/api/user", {}, { json: { username: `du${S}`, email: `du${S}@test.vn`, password: "Delete1234", role: "Judge", isActive: true } });
  await call(A, "DELETE", "/api/user/:id", { id: data(r).id });
  r = await call(A, "POST", "/api/user", {}, { json: { username: `dm${S}`, email: `dm${S}@test.vn`, password: "Delete1234", role: "Judge", isActive: true } });
  await call(A, "POST", "/api/user/delete-many", {}, { json: { ids: [data(r).id] } });
  await call(A, "POST", "/api/user/import/excel", {}, {
    form: form({}, { file: [xlsx([["STT", "Tài khoản", "Mật khẩu", "Email", "Vai trò"], [1, `ix${S}`, "Import1234", `ix${S}@test.vn`, "Judge"]]), "users.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] }),
  });
  const ix = await db.user.findUnique({ where: { username: `ix${S}` } });
  check("Nhập Excel tạo được tài khoản", !!ix);
  if (ix) {
    created.users.push(ix.id);
    await call(anon, "POST", "/api/auth/login", {}, { json: { identifier: `ix${S}`, password: "Import1234" }, note: "đăng nhập tài khoản nhập từ Excel" });
  }

  // ---------- Học sinh ----------
  console.log("\n--- Học sinh ---");
  await call(A, "GET", "/api/student", {}, { query: { page: 1, limit: 5 } });
  r = await call(A, "POST", "/api/student", {}, { json: { fullName: `HS Admin tạo ${S}`, classId: cls.id, studentCode: `HS${S}` } });
  const hs = data(r);
  if (hs?.id) created.students.push(hs.id);
  await call(A, "GET", "/api/student/:id", { id: stu[0].studentId });
  await call(A, "PATCH", "/api/student/:id", { id: hs.id }, { json: { bio: "Đã sửa" } });
  await call(A, "PATCH", "/api/student/:id/toggle-active", { id: hs.id });
  await call(A, "PATCH", "/api/student/:id/toggle-active", { id: hs.id }, { note: "bật lại" });
  r = await call(A, "POST", "/api/student", {}, { json: { fullName: `HS xoá ${S}`, classId: cls.id } });
  await call(A, "DELETE", "/api/student/:id", { id: data(r).id });
  r = await call(A, "POST", "/api/student", {}, { json: { fullName: `HS xoá2 ${S}`, classId: cls.id } });
  await call(A, "POST", "/api/student/delete-many", {}, { json: { ids: [data(r).id] } });
  await call(A, "POST", "/api/student/import/excel", {}, {
    form: form({}, { file: [xlsx([["STT", "Họ tên", "Mã lớp", "Tài khoản", "MSSV"], [1, `HS Excel ${S}`, cls.id, "", `X${S}`]]), "students.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] }),
  });
  const hx = await db.student.findFirst({ where: { fullName: `HS Excel ${S}` } });
  check("Nhập Excel tạo được học sinh", !!hx);
  if (hx) created.students.push(hx.id);

  // ---------- Câu hỏi ----------
  console.log("\n--- Chủ đề / câu hỏi / gói ---");
  r = await call(A, "POST", "/api/question-topics", {}, { json: { name: `Chủ đề ${S}`, isActive: true } });
  const topic = data(r);
  created.topics = [topic.id];
  await call(A, "GET", "/api/question-topics", {}, { query: { page: 1, limit: 5 } });
  await call(A, "GET", "/api/question-topics/active");
  await call(A, "GET", "/api/question-topics/:id", { id: topic.id });
  await call(A, "PUT", "/api/question-topics/:id", { id: topic.id }, { json: { name: `Chủ đề ${S} sửa` } });
  await call(A, "PATCH", "/api/question-topics/:id/toggle-active", { id: topic.id });
  await call(A, "PATCH", "/api/question-topics/:id/toggle-active", { id: topic.id }, { note: "bật lại" });
  r = await call(A, "POST", "/api/question-topics", {}, { json: { name: `Chủ đề xoá ${S}` } });
  await call(A, "PATCH", "/api/question-topics/:id", { id: data(r).id }, { note: "PATCH = xoá" });
  r = await call(A, "POST", "/api/question-topics", {}, { json: { name: `Chủ đề xoá2 ${S}` } });
  await call(A, "DELETE", "/api/question-topics/batch-delete", {}, { json: { ids: [data(r).id] } });

  const qs = [];
  const qData = [
    ["Thủ đô của Việt Nam là gì?", ["Hà Nội", "Huế", "Đà Nẵng", "TP.HCM"], "Hà Nội"],
    ["2 + 2 bằng mấy?", ["3", "4", "5", "6"], "4"],
    ["Nước sôi ở bao nhiêu độ C?", ["90", "100", "110", "120"], "100"],
    ["Câu tạm để xoá mềm khỏi gói", ["A", "B"], "A"],
  ];
  for (const [content, options, correctAnswer] of qData) {
    r = await call(A, "POST", "/api/questions", {}, {
      json: { content: `<p>${content}</p>`, questionType: "multiple_choice", options, correctAnswer, defaultTime: 30, score: 10, difficulty: "Alpha", questionTopicId: topic.id },
    });
    qs.push(data(r));
  }
  created.questions = qs.map(q => q?.id);
  await call(anon, "GET", "/api/questions", {}, { query: { page: 1, limit: 5, questionTopicId: topic.id } });
  await call(anon, "GET", "/api/questions/:id", { id: qs[0].id });
  await call(A, "PATCH", "/api/questions/:id", { id: qs[0].id }, { json: { explanation: "Hà Nội là thủ đô" } });
  await call(A, "POST", "/api/questions/:id/media", { id: qs[0].id }, { form: form({ mediaType: "questionMedia" }, { media: [PNG, "anh.png", "image/png"] }) });
  r = await call(A, "POST", "/api/questions", {}, { json: { content: "<p>Xoá mềm</p>", questionType: "essay", correctAnswer: "x", defaultTime: 30, difficulty: "Beta", questionTopicId: topic.id } });
  const qTmp = data(r);
  await call(A, "PUT", "/api/questions/:id", { id: qTmp.id }, { note: "đảo trạng thái (xoá mềm)" });
  await call(A, "DELETE", "/api/questions/:id/hard", { id: qTmp.id });
  r = await call(A, "POST", "/api/questions", {}, { json: { content: "<p>Xoá loạt</p>", questionType: "essay", correctAnswer: "x", defaultTime: 30, difficulty: "Beta", questionTopicId: topic.id } });
  await call(A, "DELETE", "/api/questions/batch", {}, { json: { ids: [data(r).id], hardDelete: true } });

  r = await call(A, "POST", "/api/question-packages", {}, { json: { name: `Gói ${S}`, isActive: true } });
  const pkg = data(r);
  created.packages = [pkg.id];
  await call(A, "GET", "/api/question-packages", {}, { query: { page: 1, limit: 5 } });
  await call(A, "GET", "/api/question-packages/active");
  await call(A, "GET", "/api/question-packages/get-question-package");
  await call(A, "GET", "/api/question-packages/:id", { id: pkg.id });
  await call(A, "PUT", "/api/question-packages/:id", { id: pkg.id }, { json: { name: `Gói ${S} sửa` } });
  await call(A, "PATCH", "/api/question-packages/:id/toggle-active", { id: pkg.id });
  await call(A, "PATCH", "/api/question-packages/:id/toggle-active", { id: pkg.id }, { note: "bật lại" });
  for (const [method, tpl, body] of [
    ["DELETE", "/api/question-packages/:id"],
    ["PATCH", "/api/question-packages/:id"],
    ["DELETE", "/api/question-packages/batch-delete", "ids"],
    ["POST", "/api/question-packages/delete-many", "ids"],
  ]) {
    r = await call(A, "POST", "/api/question-packages", {}, { json: { name: `Gói xoá ${S} ${method}${tpl.length}` } });
    const id = data(r).id;
    await call(A, method, tpl, { id }, body ? { json: { ids: [id] } } : {});
  }

  // Chi tiết gói
  await call(A, "POST", "/api/question-details", {}, { json: { questionId: qs[0].id, questionPackageId: pkg.id, questionOrder: 1 } });
  await call(A, "POST", "/api/question-details/bulk", {}, {
    json: { questionPackageId: pkg.id, questions: [{ questionId: qs[1].id, questionOrder: 2 }, { questionId: qs[2].id, questionOrder: 3 }, { questionId: qs[3].id, questionOrder: 4 }] },
  });
  await call(A, "GET", "/api/question-details", {}, { query: { page: 1, limit: 5 } });
  await call(A, "GET", "/api/question-details/stats");
  await call(A, "GET", "/api/question-details/package/:packageId", { packageId: pkg.id });
  await call(A, "GET", "/api/question-details/package/:packageId/next-order", { packageId: pkg.id });
  await call(A, "GET", "/api/question-details/question/:questionId", { questionId: qs[0].id });
  await call(A, "GET", "/api/question-details/:questionId/:questionPackageId", { questionId: qs[0].id, questionPackageId: pkg.id });
  await call(A, "PUT", "/api/question-details/:questionId/:questionPackageId", { questionId: qs[0].id, questionPackageId: pkg.id }, { json: { isActive: true } });
  await call(A, "PUT", "/api/question-details/reorder", {}, { json: { questionPackageId: pkg.id, reorders: [{ questionId: qs[1].id, newOrder: 3 }, { questionId: qs[2].id, newOrder: 2 }] } });
  await call(A, "PUT", "/api/question-details/reorder", {}, { json: { questionPackageId: pkg.id, reorders: [{ questionId: qs[1].id, newOrder: 2 }, { questionId: qs[2].id, newOrder: 3 }] }, note: "trả lại thứ tự" });
  await call(A, "PATCH", "/api/question-details/:questionId/:questionPackageId/deactivate", { questionId: qs[3].id, questionPackageId: pkg.id });
  await call(A, "DELETE", "/api/question-details/:questionId/:questionPackageId", { questionId: qs[3].id, questionPackageId: pkg.id });
  await call(A, "POST", "/api/question-details", {}, { json: { questionId: qs[3].id, questionPackageId: pkg.id, questionOrder: 4 }, note: "thêm lại để xoá vĩnh viễn" });
  await call(A, "DELETE", "/api/question-details/:questionId/:questionPackageId/hard", { questionId: qs[3].id, questionPackageId: pkg.id });
  await call(A, "PUT", "/api/question-details/package/:packageId/normalize-orders", { packageId: pkg.id });
  await call(A, "GET", "/api/question-details/package/:packageId/available-questions", { packageId: pkg.id }, { query: { page: 1, limit: 5 } });
  await call(A, "POST", "/api/question-details", {}, { json: { questionId: qs[3].id, questionPackageId: pkg.id, questionOrder: 4 }, note: "thêm lại để xoá loạt" });
  await call(A, "DELETE", "/api/question-details/batch-delete", {}, { json: { items: [{ questionId: qs[3].id, questionPackageId: pkg.id }] } });
  await call(A, "PUT", "/api/question-details/package/:packageId/sync", { packageId: pkg.id }, {
    json: { questions: [{ questionId: qs[0].id, questionOrder: 1 }, { questionId: qs[1].id, questionOrder: 2 }, { questionId: qs[2].id, questionOrder: 3 }] },
  });
  const pkgCount = await db.questionDetail.count({ where: { questionPackageId: pkg.id, isActive: true } });
  check("Gói câu hỏi có đúng 3 câu sau đồng bộ", pkgCount === 3, `thực tế ${pkgCount}`);

  // ---------- Cuộc thi / vòng / trận ----------
  console.log("\n--- Cuộc thi / vòng / trận ---");
  const now = Date.now();
  const iso = h => new Date(now + h * 3600e3).toISOString();
  r = await call(A, "POST", "/api/contest", {}, { json: { name: `Cuộc thi Test ${S}`, rule: "<p>Luật</p>", location: "Hội trường", startTime: iso(0), endTime: iso(24), status: "ongoing", slogan: "Test", isActive: true } });
  const contest = data(r);
  created.contests = [contest.id];
  const slug = contest.slug;
  await call(A, "GET", "/api/contest", {}, { query: { page: 1, limit: 5, search: "Test" } });
  await call(A, "GET", "/api/contest/:id", { id: contest.id });
  await call(A, "GET", "/api/contest/not-conest/:slug", { slug });
  await call(A, "PATCH", "/api/contest/:id", { id: contest.id }, { json: { slogan: "Đã sửa" } });
  await call(A, "PATCH", "/api/contest/:id/toggle-active", { id: contest.id });
  await call(A, "PATCH", "/api/contest/:id/toggle-active", { id: contest.id }, { note: "bật lại" });
  for (const [m, tpl, ids] of [["DELETE", "/api/contest/:id"], ["POST", "/api/contest/delete-many", true]]) {
    r = await call(A, "POST", "/api/contest", {}, { json: { name: `Cuộc thi xoá ${S} ${m}`, rule: "x", location: "x", startTime: iso(0), endTime: iso(1) } });
    await call(A, m, tpl, { id: data(r).id }, ids ? { json: { ids: [data(r).id] } } : {});
  }

  r = await call(A, "POST", "/api/round/contest/:slug", { slug }, { json: { name: "Vòng 1", index: 1, startTime: iso(0), endTime: iso(5), isActive: true, contestId: contest.id } });
  const round = data(r);
  await call(A, "GET", "/api/round/contest/:slug", { slug });
  await call(A, "GET", "/api/round/contest/:slug/get-round", { slug });
  await call(A, "GET", "/api/round/list-round/:id", { id: contest.id });
  await call(A, "GET", "/api/round", {}, { query: { page: 1, limit: 5 } });
  await call(A, "GET", "/api/round/:id", { id: round.id });
  await call(A, "PATCH", "/api/round/:id", { id: round.id }, { json: { name: "Vòng 1 (sửa)" } });
  await call(A, "PATCH", "/api/round/:id/toggle-active", { id: round.id });
  await call(A, "PATCH", "/api/round/:id/toggle-active", { id: round.id }, { note: "bật lại" });
  for (const [m, tpl, ids] of [["DELETE", "/api/round/:id"], ["POST", "/api/round/delete-many", true]]) {
    r = await call(A, "POST", "/api/round/contest/:slug", { slug }, { json: { name: `Vòng xoá ${m}`, index: 9, startTime: iso(0), endTime: iso(1), isActive: true, contestId: contest.id } });
    await call(A, m, tpl, { id: data(r).id }, ids ? { json: { ids: [data(r).id] } } : {});
  }

  const matchBody = name => ({ name, roundId: round.id, questionPackageId: pkg.id, startTime: iso(0), endTime: iso(2), currentQuestion: 1, status: "upcoming", maxContestantColumn: 10, isActive: true, contestId: contest.id });
  r = await call(A, "POST", "/api/match/contest/:slug", { slug }, { json: matchBody(`Trận Test ${S}`) });
  const match = data(r);
  const mslug = match.slug;
  await call(A, "GET", "/api/match/contest/:slug", { slug });
  await call(A, "GET", "/api/match/contest/:slug/all", { slug }, { query: { page: 1, limit: 5 } });
  await call(A, "GET", "/api/match/:id", { id: match.id });
  await call(A, "PATCH", "/api/match/:id", { id: match.id }, { json: { maxContestantColumn: 8 } });
  await call(A, "PATCH", "/api/match/:id/toggle-active", { id: match.id });
  await call(A, "PATCH", "/api/match/:id/toggle-active", { id: match.id }, { note: "bật lại" });
  r = await call(A, "POST", "/api/match/contest/:slug", { slug }, { json: matchBody(`Trận xoá ${S}`) });
  const mDel = data(r);
  await call(A, "DELETE", "/api/match/:id", { id: mDel.id }, { note: "xoá trận vừa tạo" });
  r = await call(A, "POST", "/api/match/contest/:slug", { slug }, { json: matchBody(`Trận xoá2 ${S}`) });
  const mDel2 = data(r);
  await call(A, "POST", "/api/match/delete-many", {}, { json: { ids: [mDel2.id] } });

  // ---------- Thí sinh ----------
  console.log("\n--- Thí sinh trong cuộc thi ---");
  await call(A, "GET", "/api/student/not-contest/:slug", { slug }, { query: { page: 1, limit: 5 } });
  await call(A, "GET", "/api/contestant/not-contest/:slug", { slug }, { query: { page: 1, limit: 5 } });
  for (const s of stu.slice(0, 2)) {
    await call(A, "POST", "/api/contestant/contest/:slug", { slug }, { json: { studentId: s.studentId, roundId: round.id, contestId: contest.id } });
  }
  await call(A, "POST", "/api/contestant/bulk/contest/:slug", { slug }, { json: { ids: [stu[2].studentId], roundId: round.id } });
  const contestants = await db.contestant.findMany({ where: { contestId: contest.id }, orderBy: { id: "asc" } });
  check("Đủ 3 thí sinh trong cuộc thi", contestants.length === 3, `thực tế ${contestants.length}`);
  stu.forEach((s, i) => (s.contestantId = contestants.find(c => c.studentId === s.studentId)?.id));
  await call(A, "GET", "/api/contestant/contest/:slug", { slug }, { query: { page: 1, limit: 5 } });
  await call(A, "GET", "/api/contestant/list-contestant/:slug/list", { slug });
  await call(A, "GET", "/api/contestant/contest/:slug/with-groups", { slug });
  await call(A, "GET", "/api/contestant/:id", { id: stu[0].contestantId });
  await call(A, "PATCH", "/api/contestant/:id", { id: stu[0].contestantId }, { json: { status: "compete" } });
  r = await call(A, "POST", "/api/contestant/contest/:slug", { slug }, { json: { studentId: hs.id, roundId: round.id, contestId: contest.id }, note: "thí sinh tạm để xoá" });
  let tmpC = await db.contestant.findFirst({ where: { contestId: contest.id, studentId: hs.id } });
  if (tmpC) await call(A, "DELETE", "/api/contestant/:id", { id: tmpC.id });
  await call(A, "POST", "/api/contestant/contest/:slug", { slug }, { json: { studentId: hs.id, roundId: round.id, contestId: contest.id } });
  tmpC = await db.contestant.findFirst({ where: { contestId: contest.id, studentId: hs.id } });
  if (tmpC) await call(A, "POST", "/api/contestant/delete-many", {}, { json: { ids: [tmpC.id] } });

  // ---------- Chia nhóm ----------
  console.log("\n--- Chia nhóm / nhóm ---");
  await call(A, "GET", "/api/group-division/judges", {}, { query: { page: 1, limit: 50 } });
  await call(A, "GET", "/api/group-division/schools");
  await call(A, "GET", "/api/group-division/schools/:schoolId/classes", { schoolId: school.id });
  r = await call(A, "GET", "/api/group-division/matches/:matchId/contestants", { matchId: match.id }, { query: { page: 1, limit: 100 } });
  const avail = list(data(r)).map(c => c.id);
  check("Có 3 thí sinh để chia nhóm", avail.length === 3, `thực tế ${avail.length}`);
  await call(A, "POST", "/api/group-division/matches/:matchId/divide-groups", { matchId: match.id }, {
    json: { groups: [{ judgeId: judge.id, groupName: "Nhóm A", contestantIds: avail }] },
  });
  await call(A, "GET", "/api/group-division/matches/:matchId/groups", { matchId: match.id });
  await call(A, "GET", "/api/group-division/matches/:matchId/groups/unsorted", { matchId: match.id });
  // Mỗi trọng tài chỉ phụ trách 1 nhóm/trận → dùng trọng tài thứ hai
  r = await call(A, "POST", "/api/user", {}, { json: { username: `jb${S}`, email: `jb${S}@test.vn`, password: "Judge1234", role: "Judge", isActive: true } });
  const judgeB = data(r);
  r = await call(A, "POST", "/api/group-division/matches/:matchId/groups", { matchId: match.id }, { json: { groupName: "Nhóm B", judgeId: judgeB.id } });
  const grpB = data(r)?.id ?? (await db.group.findFirst({ where: { matchId: match.id, name: "Nhóm B" } }))?.id;
  await call(A, "PUT", "/api/group-division/groups/:groupId/name", { groupId: grpB }, { json: { name: "Nhóm B2" } });
  const grpA = await db.group.findFirst({ where: { matchId: match.id, name: "Nhóm A" } });
  await call(A, "POST", "/api/group-division/matches/:matchId/assign-contestants-to-groups", { matchId: match.id }, {
    json: { groups: [{ groupId: grpA.id, contestantIds: avail }] }, note: "gán lại vào nhóm A",
  });
  r = await call(A, "POST", "/api/group-division/export/excel", {}, { json: { matchId: match.id } });
  check("Xuất Excel chia nhóm trả file xlsx", Buffer.isBuffer(r.data) && r.data.length > 100, r.type);
  await call(A, "DELETE", "/api/group-division/groups/:groupId", { groupId: grpB });
  const grpC = await db.group.create({ data: { name: "Nhóm xoá", matchId: match.id, userId: judge.id, confirmCurrentQuestion: 0 } });
  await call(A, "DELETE", "/api/group-division/groups", {}, { json: { groupIds: [grpC.id] }, note: "xoá các nhóm theo id" });
  await call(J, "GET", "/api/group-division/contestant/judge/:match", { match: mslug });
  await call(A, "GET", "/api/group-division/admin/contestant/judge/:match", { match: mslug });
  const cms = await db.contestantMatch.findMany({ where: { matchId: match.id }, orderBy: { registrationNumber: "asc" } });
  check("Thí sinh được cấp số báo danh", cms.length === 3 && cms.every(c => c.registrationNumber > 0), JSON.stringify(cms.map(c => c.registrationNumber)));
  stu.forEach(s => (s.reg = cms.find(c => c.contestantId === s.contestantId)?.registrationNumber));

  await call(A, "GET", "/api/group/contest/:slug", { slug }, { query: { page: 1, limit: 5 } });
  await call(J, "GET", "/api/group/match/:match", { match: mslug });
  await call(A, "GET", "/api/group/:id", { id: grpA.id });
  r = await call(A, "POST", "/api/group", {}, { json: { name: "Nhóm tạo tay", userId: judgeB.id, matchId: match.id, confirmCurrentQuestion: 0 } });
  const g1 = data(r)?.id ?? (await db.group.findFirst({ where: { matchId: match.id, name: "Nhóm tạo tay" } }))?.id;
  await call(A, "PATCH", "/api/group/:id", { id: g1 }, { json: { confirmCurrentQuestion: 0 } });
  await call(A, "PATCH", "/api/group/:id/name", { id: g1 }, { json: { name: "Nhóm tạo tay 2" } });
  await call(A, "DELETE", "/api/group/:id", { id: g1 });
  await call(A, "POST", "/api/group/bulk", {}, { json: { matchId: match.id, groupNames: ["Bulk 1", "Bulk 2"] } });
  const bulk = await db.group.findMany({ where: { matchId: match.id, name: { startsWith: "Bulk" } } });
  await call(A, "POST", "/api/group/delete-many", {}, { json: { ids: bulk.map(b => b.id) } });

  // ---------- Thông tin trận ----------
  console.log("\n--- Màn hình điều khiển trận ---");
  for (const t of ["matchInfo", "bgContest", "CurrentQuestion", "ListRescues", "ListContestant", "countContestant", "ListQuestion", "ScreenControl"]) {
    await call(A, "GET", `/api/match/:slug/${t}`, { slug: mslug });
  }
  await call(J, "GET", "/api/match/:slug/matchInfo", { slug: mslug }, { note: "trọng tài" });
  await call(J, "GET", "/api/contest/list-contest/judge");
  r = await call(J, "GET", "/api/match/judge/:id", { id: contest.id });
  check("Trọng tài thấy trận được phân công", list(data(r)).some(m => m.id === match.id));

  // ---------- Thí sinh đăng nhập ----------
  console.log("\n--- Thí sinh ---");
  const T1 = await login("Thí sinh 1", stu[0].username, pw, true);
  const T2 = await login("Thí sinh 2", stu[1].username, pw, true);
  r = await call(T1, "GET", "/api/auth/profile-student");
  check("Hồ sơ thí sinh trỏ đúng cuộc thi", data(r)?.contest?.id === contest.id);
  await call(T1, "GET", "/api/auth/registration-number", {}, { query: { contestantId: stu[0].contestantId, matchId: match.id } });
  await call(T1, "GET", "/api/auth/student");
  await call(T1, "POST", "/api/auth/change-password", {}, { json: { currentPassword: pw, newPassword: "Doimk1234", confirmNewPassword: "Doimk1234" } });
  await call(anon, "POST", "/api/auth/student-login", {}, { json: { identifier: stu[0].username, password: "Doimk1234" }, note: "đăng nhập mật khẩu mới" });
  const T1b = await login("Thí sinh 1", stu[0].username, "Doimk1234", true);
  await call(T1b, "POST", "/api/auth/change-info", {}, { json: { email: `${stu[0].username}.moi@test.vn` } });

  // ---------- Phân quyền (bảo mật) ----------
  console.log("\n--- Kiểm tra phân quyền ---");
  const before = await db.school.count();
  await call(T2, "POST", "/api/school", {}, { json: { name: `Trường thí sinh tạo ${S}`, email: `hack${S}@test.vn`, phone: `06${S.padStart(8, "0")}`.slice(0, 10), address: "x" }, expect: 403, note: "thí sinh tạo trường" });
  await new Promise(r => setTimeout(r, 300));
  const after = await db.school.count();
  check("Thí sinh KHÔNG tạo được dữ liệu admin", after === before, `số trường tăng ${before} → ${after}`);
  const leaked = await db.school.findFirst({ where: { email: `hack${S}@test.vn` } });
  if (leaked) created.schools.push(leaked.id);
  await call(T2, "GET", "/api/user", {}, { expect: 403, note: "thí sinh xem danh sách tài khoản" });
  await call(J, "DELETE", "/api/contest/:id", { id: contest.id }, { expect: 403, note: "trọng tài xoá cuộc thi" });
  const stillThere = await db.contest.findUnique({ where: { id: contest.id } });
  check("Trọng tài KHÔNG xoá được cuộc thi", !!stillThere);

  // ---------- Realtime ----------
  console.log("\n--- Realtime (Socket.IO) ---");
  const sAdmin = await connectSocket(A, "/match-control");
  const sJudge = await connectSocket(J, "/match-control");
  const sT1 = await connectSocket(T1b, "/student");
  check("Socket admin kết nối", sAdmin.ok, sAdmin.err);
  check("Socket trọng tài kết nối", sJudge.ok, sJudge.err);
  check("Socket thí sinh kết nối", sT1.ok, sT1.err);
  const sNo = await connectSocket(new Session("Chưa đăng nhập"), "/match-control");
  check("Socket không có token bị từ chối", !sNo.ok, "kết nối được khi chưa đăng nhập");
  sNo.s.close();
  if (sAdmin.ok && sJudge.ok && sT1.ok) {
    await emit(sAdmin.s, "joinMatchRoom", mslug);
    await emit(sAdmin.s, "onlineControl:joinMatch", { matchSlug: mslug });
    await emit(sJudge.s, "joinMatchRoom", mslug);
    await emit(sT1.s, "joinMatchRoom", match.id);
    await emit(sT1.s, "student:joinMatch", { matchSlug: mslug });
    const gotStart = new Promise(res => { sT1.s.once("match:started", () => res(true)); setTimeout(() => res(false), 4000); });
    const st = await emit(sAdmin.s, "match:start", { matchId: match.id });
    check("match:start", st.success === true, JSON.stringify(st));
    check("Thí sinh nhận match:started", await gotStart);
    sT1.s.emit("student:confirmStart", { contestantId: stu[0].contestantId, matchId: match.id });
    await new Promise(r => setTimeout(r, 400));
    const gotQ = new Promise(res => { sT1.s.once("match:questionShown", d => res(d)); setTimeout(() => res(null), 4000); });
    const cq = await emit(sAdmin.s, "currentQuestion:get", { match: mslug, questionOrder: 1 });
    check("currentQuestion:get", cq.success !== false, JSON.stringify(cq));
    const q = await gotQ;
    check("Thí sinh nhận câu hỏi 1", !!q, "không nhận được match:questionShown");
    const tick = new Promise(res => { sT1.s.once("timer:update", d => res(d)); setTimeout(() => res(null), 4000); });
    await emit(sAdmin.s, "timer:play", { match: mslug });
    check("Thí sinh nhận đồng hồ đếm", !!(await tick));
    await emit(sAdmin.s, "timer:pause", { match: mslug });
    const jd = await emit(sJudge.s, "contestant:status-update-judge", { match: mslug, userId: judge.id, status: "confirmed1", ids: [stu[2].reg] });
    check("Trọng tài xác nhận thí sinh qua socket", jd.success === true, JSON.stringify(jd));

    // Thí sinh dùng socket điều khiển dành cho admin
    const sHack = await connectSocket(T2, "/match-control");
    if (sHack.ok) {
      const h = await emit(sHack.s, "timer:reset", { match: mslug });
      check("Thí sinh KHÔNG điều khiển được trận qua /match-control", h.success === false || h.timeout, `thí sinh gọi timer:reset → ${JSON.stringify(h)}`);
      sHack.s.close();
    } else check("Thí sinh KHÔNG điều khiển được trận qua /match-control", true);
  }

  // ---------- Kết quả ----------
  console.log("\n--- Kết quả / nộp bài ---");
  r = await call(T1b, "POST", "/api/results/submit-answer", {}, { json: { matchId: match.id, questionOrder: 1, answer: "Hà Nội" } });
  check("Nộp đáp án đúng được chấm đúng", data(r)?.result?.isCorrect === true, JSON.stringify(data(r)));
  await call(T1b, "POST", "/api/results/submit-answer", {}, { json: { matchId: match.id, questionOrder: 1, answer: "Huế" }, expect: 400, note: "nộp lại lần 2" });
  r = await call(A, "POST", "/api/results", {}, { json: { name: "KQ test", contestantId: stu[2].contestantId, matchId: match.id, isCorrect: false, questionOrder: 1 } });
  const res1 = data(r);
  await call(A, "GET", "/api/results", {}, { query: { page: 1, limit: 5 } });
  await call(A, "GET", "/api/results/:id", { id: res1.id });
  await call(A, "PATCH", "/api/results/:id", { id: res1.id }, { json: { isCorrect: true } });
  await call(A, "GET", "/api/results/contestant/:contestantId", { contestantId: stu[0].contestantId });
  await call(A, "GET", "/api/results/contestant/:contestantId/statistics", { contestantId: stu[0].contestantId });
  await call(A, "GET", "/api/results/match/:matchId", { matchId: match.id });
  await call(A, "GET", "/api/results/contest/:slug", { slug });
  await call(J, "GET", "/api/results/:matchSlug/statistics", { matchSlug: mslug });
  await call(A, "GET", "/api/results/:matchSlug/contestant-statistics", { matchSlug: mslug });
  await call(A, "DELETE", "/api/results/:id", { id: res1.id });
  r = await call(A, "POST", "/api/results", {}, { json: { name: "KQ xoá", contestantId: stu[2].contestantId, matchId: match.id, isCorrect: false, questionOrder: 2 } });
  await call(A, "DELETE", "/api/results/batch", {}, { json: { ids: [data(r).id] } });
  await call(T2, "POST", "/api/results/ban-contestant", {}, { json: { matchId: match.id, violationType: "tab_switch", violationCount: 3, reason: "Chuyển tab nhiều lần khi thi" } });
  const banned = await db.contestantMatch.findFirst({ where: { matchId: match.id, contestantId: stu[1].contestantId } });
  check("Thí sinh vi phạm bị cấm", banned?.status === "banned", banned?.status);

  // ---------- Loại / cứu trợ ----------
  console.log("\n--- Loại / cứu trợ ---");
  await call(A, "PUT", "/api/contestant/update-to-completed/:matchId", { matchId: match.id }, { json: { contestantIds: [stu[2].contestantId] } });
  await call(A, "GET", "/api/contestant/completed-contestants/:matchId", { matchId: match.id });
  await call(A, "PUT", "/api/contestant/update-to-eliminated/:matchId", { matchId: match.id }, { json: { contestantIds: [stu[2].contestantId] } });
  await call(A, "PUT", "/api/contestant/update-all-completed-to-eliminated/:matchId", { matchId: match.id });
  await call(A, "GET", "/api/contestant/candidates-list/:matchId", { matchId: match.id });
  await call(A, "GET", "/api/contestant/eliminated/:matchId", { matchId: match.id });
  await call(A, "GET", "/api/contestant/eliminated/:matchId/list", { matchId: match.id }, { query: { page: 1, limit: 10 } });
  await call(A, "GET", "/api/contestant/:id/match/:matchId", { id: stu[0].contestantId, matchId: match.id });
  await call(A, "GET", "/api/contestant/:id/contest/:slug/match/:matchId/with-groups", { id: stu[0].contestantId, slug, matchId: match.id });
  await call(A, "GET", "/api/contestant/contest/:slug/match/:matchId/contestants", { slug, matchId: match.id }, { query: { page: 1, limit: 10 } });

  r = await call(A, "POST", "/api/rescue", {}, { json: { name: "Cứu trợ 1", rescueType: "resurrected", questionFrom: 1, questionTo: 3, remainingContestants: 1, matchId: match.id, status: "notUsed", index: 1, studentIds: [], supportAnswers: [] } });
  const rescue = data(r);
  r = await call(A, "POST", "/api/rescue", {}, { json: { name: "Phao 1", rescueType: "lifelineUsed", questionFrom: 1, questionTo: 3, remainingContestants: 1, matchId: match.id, status: "proposed", index: 2, studentIds: [], supportAnswers: [] } });
  const lifeline = data(r);
  await call(A, "GET", "/api/rescue/:id", { id: rescue.id });
  await call(A, "PATCH", "/api/rescue/:id", { id: rescue.id }, { json: { name: "Cứu trợ 1 (sửa)" } });
  await call(A, "GET", "/api/rescue/contest/:slug", { slug }, { query: { page: 1, limit: 5 } });
  await call(A, "GET", "/api/rescue/enum/type");
  await call(A, "GET", "/api/rescue/enum/status");
  await call(A, "GET", "/api/rescue/list-lifelineUsed/:slug", { slug: mslug });
  await call(A, "GET", "/api/rescue/list-all/:slug", { slug: mslug });
  await call(A, "GET", "/api/contestant/rescue-candidates/:matchId", { matchId: match.id }, { query: { rescueId: rescue.id } });
  await call(A, "PATCH", "/api/rescue/:id", { id: lifeline.id }, { json: { questionOrder: 1 }, note: "gán câu hỏi cho phao" });
  await call(anon, "GET", "/api/rescue/match/:slug/:id", { slug: mslug, id: lifeline.id });
  await call(anon, "GET", "/api/rescue/match/:matchId", { matchId: match.id });
  await call(anon, "POST", "/api/rescue/supportAnswer/:id", { id: lifeline.id }, { json: { supportAnswers: "Hà Nội" } });
  await call(anon, "GET", "/api/rescue/chart/:id", { id: lifeline.id });
  await call(A, "POST", "/api/rescue/update-status-by-question", {}, { json: { matchId: match.id, currentQuestionOrder: 1 } });
  await call(A, "POST", "/api/contestant/rescue-candidates/:matchId/rescue-many", { matchId: match.id }, { json: { contestantIds: [stu[2].contestantId], currentQuestionOrder: 1, rescueId: rescue.id } });
  await call(A, "GET", "/api/contestant/rescued/:rescueId", { rescueId: rescue.id });
  await call(A, "POST", "/api/contestant/rescue/add-students", {}, { json: { rescueId: rescue.id, studentIds: [stu[2].studentId] } });
  await call(A, "DELETE", "/api/contestant/rescue/remove-student", {}, { json: { rescueId: rescue.id, studentId: stu[2].studentId } });
  await call(A, "DELETE", "/api/rescue/:id", { id: lifeline.id });
  r = await call(A, "POST", "/api/rescue", {}, { json: { name: "Xoá", rescueType: "resurrected", questionFrom: 1, questionTo: 2, remainingContestants: 1, matchId: match.id, status: "notUsed" } });
  await call(A, "POST", "/api/rescue/delete-many", {}, { json: { ids: [data(r).id] } });

  // ---------- Giải thưởng ----------
  console.log("\n--- Giải thưởng ---");
  r = await call(A, "POST", "/api/awards/contest/:slug", { slug }, { json: { name: "Giải nhất", type: "firstPrize", contestantId: stu[0].contestantId, matchId: match.id } });
  const award = data(r);
  r = await call(A, "POST", "/api/awards", {}, { json: { name: "Giải nhì", contestId: contest.id, type: "secondPrize", matchId: match.id } });
  const award2 = data(r);
  await call(anon, "GET", "/api/awards/contest/:slug", { slug });
  await call(anon, "GET", "/api/awards/match/:matchSlug", { matchSlug: mslug });
  await call(anon, "GET", "/api/awards/:id", { id: award.id });
  await call(A, "PATCH", "/api/awards/:id", { id: award.id }, { json: { name: "Giải nhất (sửa)" } });
  await call(A, "DELETE", "/api/awards/:id", { id: award2.id });
  r = await call(A, "POST", "/api/awards", {}, { json: { name: "Giải ba", contestId: contest.id, type: "thirdPrize" } });
  await call(A, "DELETE", "/api/awards/batch", {}, { json: { ids: [data(r).id] } });

  // ---------- Media / video / nhà tài trợ ----------
  console.log("\n--- Media / video lớp / nhà tài trợ ---");
  r = await call(A, "POST", "/api/media/contest/:slug", { slug }, { form: form({ type: "logo" }, { media: [PNG, "logo.png", "image/png"] }) });
  const media = data(r);
  await call(A, "GET", "/api/media/contest/:slug", { slug }, { query: { page: 1, limit: 5 } });
  if (media?.id) {
    await call(A, "GET", "/api/media/:id", { id: media.id });
    await call(A, "PATCH", "/api/media/:id", { id: media.id }, { form: form({ type: "images" }, { media: [PNG, "anh.png", "image/png"] }) });
    const fileOk = await anon.send("GET", "/" + String((await db.media.findUnique({ where: { id: media.id } }))?.url || "").replace(/^\//, ""));
    check("File media tải lại được qua /uploads", fileOk.status === 200, `status ${fileOk.status}`);
    await call(A, "DELETE", "/api/media/:id", { id: media.id });
  }
  r = await call(A, "POST", "/api/media/contest/:slug", { slug }, { form: form({ type: "images" }, { media: [PNG, "x.png", "image/png"] }) });
  if (data(r)?.id) await call(A, "POST", "/api/media/delete-many", {}, { json: { ids: [data(r).id] } });

  r = await call(A, "POST", "/api/class-video/contest/:slug", { slug }, { form: form({ name: "Video lớp", classId: cls.id, slogan: "Cố lên" }, { videos: [MP4, "v.mp4", "video/mp4"] }) });
  const cv = data(r);
  await call(A, "GET", "/api/class-video/contest/:slug", { slug }, { query: { page: 1, limit: 5 } });
  await call(A, "GET", "/api/class-video/contest/list-video/:slug", { slug });
  if (cv?.id) {
    await call(A, "GET", "/api/class-video/:id", { id: cv.id });
    await call(A, "PATCH", "/api/class-video/:id", { id: cv.id }, { form: form({ slogan: "Sửa" }) });
    await call(A, "DELETE", "/api/class-video/:id", { id: cv.id });
  }
  r = await call(A, "POST", "/api/class-video/contest/:slug", { slug }, { form: form({ name: "Video xoá", classId: cls.id }, { videos: [MP4, "v2.mp4", "video/mp4"] }) });
  if (data(r)?.id) await call(A, "POST", "/api/class-video/delete-many", {}, { json: { ids: [data(r).id] } });

  r = await call(A, "POST", "/api/sponsors/contest/:slug", { slug }, { form: form({ name: `Nhà tài trợ ${S}` }, { logo: [PNG, "logo.png", "image/png"] }) });
  const sp = data(r);
  r = await call(A, "POST", "/api/sponsors", {}, { json: { name: `Nhà tài trợ JSON ${S}`, contestId: contest.id } });
  const sp2 = data(r);
  await call(anon, "GET", "/api/sponsors/contest/:slug", { slug });
  await call(A, "GET", "/api/sponsors/contest/list-video/:slug", { slug });
  await call(A, "GET", "/api/sponsors/statistics");
  if (sp?.id) {
    await call(anon, "GET", "/api/sponsors/:id", { id: sp.id });
    await call(A, "PATCH", "/api/sponsors/:id", { id: sp.id }, { json: { name: `Nhà tài trợ ${S} sửa` } });
    await call(A, "DELETE", "/api/sponsors/:id", { id: sp.id });
  }
  if (sp2?.id) await call(A, "POST", "/api/sponsors/batch", {}, { json: { ids: [sp2.id] } });

  // ---------- Màn hình ----------
  console.log("\n--- Màn hình trình chiếu ---");
  const screen = await db.screenControl.findUnique({ where: { matchId: match.id } });
  await call(A, "GET", "/api/screen", {}, { query: { page: 1, limit: 5 } });
  await call(A, "GET", "/api/screen/:id", { id: screen.id });
  await call(A, "PATCH", "/api/screen/:id", { id: screen.id }, { json: { controlKey: "question", controlValue: "start" } });
  await call(A, "POST", "/api/screen", {}, { json: { controlKey: "background", controlValue: "start", matchId: match.id }, expect: 400, note: "mỗi trận chỉ 1 màn hình" });
  const mScr = await db.match.create({ data: { name: `Trận màn hình ${S}`, slug: `tran-man-hinh-${S}`, startTime: new Date(), endTime: new Date(), currentQuestion: 1, questionPackageId: pkg.id, contestId: contest.id, roundId: round.id } });
  r = await call(A, "POST", "/api/screen", {}, { json: { controlKey: "background", controlValue: "start", matchId: mScr.id } });
  if (data(r)?.id) await call(A, "DELETE", "/api/screen/:id", { id: data(r).id });
  r = await call(A, "POST", "/api/screen", {}, { json: { controlKey: "background", controlValue: "start", matchId: mScr.id } });
  if (data(r)?.id) await call(A, "POST", "/api/screen/delete-many", {}, { json: { ids: [data(r).id] } });
  created.extraMatches = [mScr.id];

  // ---------- Giới thiệu / Excel / enum ----------
  console.log("\n--- Giới thiệu / Excel / enum ---");
  await call(anon, "GET", "/api/about", {}, { query: { page: 1, limit: 5 } });
  r = await call(A, "POST", "/api/about", {}, { form: form({ schoolName: `Trường giới thiệu ${S}`, email: `about${S}@test.vn` }, { logo: [PNG, "logo.png", "image/png"] }) });
  const about = data(r);
  if (about?.id) {
    created.abouts = [about.id];
    await call(anon, "GET", "/api/about/:id", { id: about.id });
    await call(A, "PUT", "/api/about/:id", { id: about.id }, { form: form({ departmentName: "Khoa CNTT" }) });
    await call(A, "DELETE", "/api/about/:id", { id: about.id });
    await call(A, "PATCH", "/api/about/:id/restore", { id: about.id });
    await call(A, "DELETE", "/api/about/:id/permanent", { id: about.id });
  }
  r = await call(A, "POST", "/api/excel/export", {}, { json: { data: [{ a: 1, b: "Xin chào" }], fileName: "test" } });
  check("Xuất Excel trả file", Buffer.isBuffer(r.data) && r.data.length > 100, r.type);
  r = await call(A, "POST", "/api/excel/import", {}, { form: form({}, { file: [xlsx([["id", "user"], [1, "abc"]]), "a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] }) });
  check("Đọc Excel đúng dữ liệu", list(data(r))[0]?.username === "abc" || data(r)?.[0]?.username === "abc", JSON.stringify(data(r)));
  for (const t of ["/api/enums", "/api/enums/names", "/api/enums/:enumName", "/api/enums/:enumName/values", "/api/enums/:enumName/options"]) {
    await call(anon, "GET", t, { enumName: "Role" });
  }

  // ---------- Kết thúc trận + đăng xuất ----------
  if (sAdmin.ok) {
    const end = await emit(sAdmin.s, "match:end", { matchId: match.id });
    check("match:end", end.success === true, JSON.stringify(end));
    for (const x of [sAdmin, sJudge, sT1]) x.s.close();
  }
  const L = await login("Đăng xuất", `jd${S}`, "Judge1234");
  await call(L, "POST", "/api/auth/logout");
  await call(L, "GET", "/api/auth/profile", {}, { expect: 401, note: "sau khi đăng xuất" });

  Object.assign(created, { contest, match, mDel, mDel2, pkg, round });
}

// ------------------------------------------------------------- Dọn dẹp ---
async function cleanup() {
  console.log("\n--- Dọn dữ liệu test ---");
  const contests = await db.contest.findMany({ where: { name: { contains: S } } });
  const cIds = contests.map(c => c.id);
  const matches = await db.match.findMany({ where: { contestId: { in: cIds } } });
  const mIds = matches.map(m => m.id);
  const steps = [
    () => db.result.deleteMany({ where: { matchId: { in: mIds } } }),
    () => db.contestantMatch.deleteMany({ where: { matchId: { in: mIds } } }),
    () => db.group.deleteMany({ where: { matchId: { in: mIds } } }),
    () => db.award.deleteMany({ where: { contestId: { in: cIds } } }),
    () => db.rescue.deleteMany({ where: { matchId: { in: mIds } } }),
    () => db.screenControl.deleteMany({ where: { matchId: { in: mIds } } }),
    () => db.match.deleteMany({ where: { id: { in: mIds } } }),
    () => db.contestant.deleteMany({ where: { contestId: { in: cIds } } }),
    () => db.round.deleteMany({ where: { contestId: { in: cIds } } }),
    () => db.media.deleteMany({ where: { contestId: { in: cIds } } }),
    () => db.classVideo.deleteMany({ where: { contestId: { in: cIds } } }),
    () => db.sponsor.deleteMany({ where: { OR: [{ contestId: { in: cIds } }, { name: { contains: S } }] } }),
    () => db.contest.deleteMany({ where: { id: { in: cIds } } }),
    () => db.questionDetail.deleteMany({ where: { questionPackage: { name: { contains: S } } } }),
    () => db.match.deleteMany({ where: { questionPackage: { name: { contains: S } } } }),
    () => db.questionPackage.deleteMany({ where: { name: { contains: S } } }),
    () => db.questionDetail.deleteMany({ where: { question: { questionTopic: { name: { contains: S } } } } }),
    () => db.question.deleteMany({ where: { questionTopic: { name: { contains: S } } } }),
    () => db.questionTopic.deleteMany({ where: { name: { contains: S } } }),
    () => db.contestant.deleteMany({ where: { student: { class: { name: { contains: S } } } } }),
    () => db.student.deleteMany({ where: { class: { name: { contains: S } } } }),
    () => db.refreshToken.deleteMany({ where: { user: { OR: [{ username: { contains: S } }, { email: { contains: S } }] } } }),
    () => db.user.deleteMany({ where: { OR: [{ username: { contains: S } }, { email: { contains: S } }] } }),
    () => db.class.deleteMany({ where: { name: { contains: S } } }),
    () => db.school.deleteMany({ where: { name: { contains: S } } }),
    () => db.about.deleteMany({ where: { schoolName: { contains: S } } }),
  ];
  for (const s of steps) {
    try {
      await s();
    } catch (e) {
      console.log("  ! dọn dẹp:", e.message.split("\n").pop());
    }
  }
  const left = await db.user.count({ where: { username: { contains: S } } }) + (await db.contest.count({ where: { name: { contains: S } } }));
  check("Đã dọn sạch dữ liệu test", left === 0, `còn ${left} bản ghi`);
}

// -------------------------------------------------------------- Báo cáo ---
function allRoutes() {
  const app = fs.readFileSync(path.join(ROOT, "src/app.ts"), "utf8");
  const imports = {};
  for (const m of app.matchAll(/import\s+(?:\{\s*(\w+)\s*\}|(\w+))\s+from\s+"[@./]*\/?modules\/(\w+)/g)) imports[m[1] || m[2]] = m[3];
  const out = new Set();
  for (const m of app.matchAll(/app\.use\("([^"]+)",\s*(\w+)\)/g)) {
    const mod = imports[m[2]];
    if (!mod || m[1] === "/api/group-divisions") continue;
    const dir = path.join(ROOT, "src/modules", mod);
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".routes.ts"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      for (const r of src.matchAll(/\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]*)["'`]/g)) {
        out.add(`${r[1].toUpperCase()} ${m[1]}${r[2] === "/" ? "" : r[2]}`);
      }
    }
  }
  return out;
}

function report() {
  const api = results.filter(r => r.kind === "api");
  const checks = results.filter(r => r.kind === "check");
  const fails = results.filter(r => !r.ok);
  const routes = allRoutes();
  const untested = [...routes].filter(r => !tested.has(r)).filter(r => !/\/api\/auth\/(student)?$/.test(r));
  console.log("\n================ BÁO CÁO ================");
  console.log(`Endpoint trong code : ${routes.size}`);
  console.log(`Endpoint đã gọi     : ${[...routes].filter(r => tested.has(r)).length}`);
  console.log(`Lượt gọi API        : ${api.length} (đạt ${api.filter(r => r.ok).length})`);
  console.log(`Kiểm tra nghiệp vụ  : ${checks.length} (đạt ${checks.filter(r => r.ok).length})`);
  if (untested.length) console.log("\nChưa gọi tới:\n  " + untested.join("\n  "));
  if (fails.length) {
    console.log(`\nKHÔNG ĐẠT (${fails.length}):`);
    for (const f of fails) {
      console.log(f.kind === "api"
        ? `  ✘ ${f.method} ${f.tpl} [${f.who}] ${f.note ? "(" + f.note + ") " : ""}→ ${f.status}${f.exp ? " (mong đợi " + f.exp + ")" : ""}: ${f.msg}`
        : `  ✘ ${f.tpl}: ${f.msg}`);
    }
  } else console.log("\nTẤT CẢ ĐỀU ĐẠT ✔");
  fs.writeFileSync(path.join(ROOT, "logs", `api-test-${S}.json`), JSON.stringify({ results, untested }, null, 2));
}

try {
  await main();
} catch (e) {
  console.error("\n!!! Kịch bản dừng giữa chừng:", e);
  results.push({ kind: "check", tpl: "Kịch bản chạy hết", ok: false, msg: String(e && e.message) });
} finally {
  await cleanup();
  report();
  await db.$disconnect();
  process.exit(0);
}
