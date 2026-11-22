// Jobs, departments, job status history and analytics snapshots in Neon Postgres.
// Every query is parameterised ($1, $2, ...). User text is never glued into SQL.
const { query, withTransaction } = require('./db');

const JOB_COLUMNS = `j.id, j.title, j.description, j.requirements, j.location, j.employment_type,
  j.department_id, d.name AS department_name, j.hiring_manager_id, j.openings, j.hired_count,
  j.salary_min, j.salary_max, j.closing_date, j.status, j.close_reason, j.created_by,
  j.created_at, j.updated_at, j.published_at, j.closed_at`;

function toJob(r) {
  if (!r) return null;
  return {
    jobId: r.id,
    title: r.title,
    description: r.description,
    requirements: r.requirements,
    location: r.location,
    employmentType: r.employment_type,
    departmentId: r.department_id,
    departmentName: r.department_name,
    hiringManagerId: r.hiring_manager_id,
    openings: r.openings,
    hiredCount: r.hired_count,
    salaryMin: r.salary_min,
    salaryMax: r.salary_max,
    closingDate: r.closing_date ? new Date(r.closing_date).toISOString().slice(0, 10) : null,
    status: r.status,
    closeReason: r.close_reason,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    publishedAt: r.published_at,
    closedAt: r.closed_at
  };
}

const toDepartment = (r) => r && ({ departmentId: r.id, name: r.name, description: r.description, jobCount: r.job_count !== undefined ? Number(r.job_count) : undefined, createdAt: r.created_at });

// ---- Departments ----------------------------------------------------------
async function listDepartments() {
  const { rows } = await query(`SELECT d.*, (SELECT count(*) FROM jobs j WHERE j.department_id = d.id) AS job_count
    FROM departments d ORDER BY d.name`);
  return rows.map(toDepartment);
}
async function getDepartment(id) {
  const { rows } = await query('SELECT * FROM departments WHERE id = $1', [id]);
  return toDepartment(rows[0]);
}
async function createDepartment({ name, description, createdBy }) {
  const { rows } = await query('INSERT INTO departments (name, description, created_by) VALUES ($1, $2, $3) RETURNING *', [name, description || null, createdBy]);
  return toDepartment(rows[0]);
}
async function deleteDepartment(id) {
  const { rowCount } = await query('DELETE FROM departments WHERE id = $1', [id]);
  return rowCount > 0;
}

// ---- Jobs -----------------------------------------------------------------
async function getJob(id) {
  const { rows } = await query(`SELECT ${JOB_COLUMNS} FROM jobs j JOIN departments d ON d.id = j.department_id WHERE j.id = $1`, [id]);
  return toJob(rows[0]);
}

// visibility: { mode: 'public' } | { mode: 'all' } | { mode: 'manager', userId }
async function searchJobs({ q, departmentId, status, location, employmentType, page, limit }, visibility) {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

  if (visibility.mode === 'public') add("j.status = ?", 'published');
  if (visibility.mode === 'manager') {
    params.push(visibility.userId);
    where.push(`(j.status = 'published' OR j.hiring_manager_id = $${params.length})`);
  }
  if (status) add('j.status = ?', status);
  if (departmentId) add('j.department_id = ?', departmentId);
  if (employmentType) add('j.employment_type = ?', employmentType);
  if (location) add('j.location ILIKE ?', `%${location}%`);
  if (q) {
    params.push(`%${q}%`);
    where.push(`(j.title ILIKE $${params.length} OR j.description ILIKE $${params.length} OR d.name ILIKE $${params.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countRes = await query(`SELECT count(*) FROM jobs j JOIN departments d ON d.id = j.department_id ${whereSql}`, params);
  params.push(limit, (page - 1) * limit);
  const { rows } = await query(
    `SELECT ${JOB_COLUMNS} FROM jobs j JOIN departments d ON d.id = j.department_id ${whereSql}
     ORDER BY j.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { items: rows.map(toJob), total: Number(countRes.rows[0].count), page, limit };
}

async function createJob(job, userId) {
  return withTransaction(async (q) => {
    const { rows } = await q(
      `INSERT INTO jobs (title, description, requirements, location, employment_type, department_id,
        hiring_manager_id, openings, salary_min, salary_max, closing_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [job.title, job.description, job.requirements || null, job.location, job.employmentType, job.departmentId,
        job.hiringManagerId || null, job.openings || 1, job.salaryMin ?? null, job.salaryMax ?? null, job.closingDate || null, userId]);
    await q('INSERT INTO job_events (job_id, from_status, to_status, reason, changed_by) VALUES ($1, NULL, $2, $3, $4)', [rows[0].id, 'draft', 'Job created', userId]);
    return rows[0].id;
  }).then(getJob);
}

const EDITABLE = {
  title: 'title', description: 'description', requirements: 'requirements', location: 'location',
  employmentType: 'employment_type', departmentId: 'department_id', hiringManagerId: 'hiring_manager_id',
  openings: 'openings', salaryMin: 'salary_min', salaryMax: 'salary_max', closingDate: 'closing_date'
};

async function updateJob(id, changes) {
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(EDITABLE)) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      params.push(changes[key] === '' ? null : changes[key]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (!sets.length) return getJob(id);
  params.push(id);
  await query(`UPDATE jobs SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
  return getJob(id);
}

async function changeStatus(id, fromStatus, toStatus, reason, userId) {
  return withTransaction(async (q) => {
    const stamp = toStatus === 'published' ? ', published_at = now(), closed_at = NULL, close_reason = NULL'
      : toStatus === 'closed' ? ', closed_at = now(), close_reason = $3' : ', published_at = NULL';
    const params = toStatus === 'closed' ? [toStatus, id, reason, fromStatus] : [toStatus, id, fromStatus];
    const fromIdx = toStatus === 'closed' ? 4 : 3;
    // "AND status = from" makes the update fail if someone else changed the job meanwhile
    const res = await q(`UPDATE jobs SET status = $1, updated_at = now()${stamp} WHERE id = $2 AND status = $${fromIdx}`, params);
    if (res.rowCount === 0) return false;
    await q('INSERT INTO job_events (job_id, from_status, to_status, reason, changed_by) VALUES ($1,$2,$3,$4,$5)', [id, fromStatus, toStatus, reason || null, userId]);
    return true;
  });
}

// Called by the pipeline service when a candidate is hired. Auto-closes a filled job.
async function recordHire(id, changedBy) {
  return withTransaction(async (q) => {
    const { rows } = await q("UPDATE jobs SET hired_count = hired_count + 1, updated_at = now() WHERE id = $1 RETURNING hired_count, openings, status", [id]);
    if (!rows[0]) return null;
    const { hired_count: hired, openings, status } = rows[0];
    let autoClosed = false;
    if (hired >= openings && status !== 'closed') {
      await q("UPDATE jobs SET status = 'closed', closed_at = now(), close_reason = 'All openings filled' WHERE id = $1", [id]);
      await q('INSERT INTO job_events (job_id, from_status, to_status, reason, changed_by) VALUES ($1,$2,$3,$4,$5)', [id, status, 'closed', 'All openings filled (automatic)', changedBy]);
      autoClosed = true;
    }
    return { autoClosed };
  }).then(async (r) => (r ? { job: await getJob(id), autoClosed: r.autoClosed } : null));
}

async function jobHistory(id) {
  const { rows } = await query('SELECT * FROM job_events WHERE job_id = $1 ORDER BY changed_at, id', [id]);
  return rows.map((r) => ({ fromStatus: r.from_status, toStatus: r.to_status, reason: r.reason, changedBy: r.changed_by, changedAt: r.changed_at }));
}

async function jobsForScope({ jobId, departmentId, managerId }) {
  const where = [];
  const params = [];
  if (jobId) { params.push(jobId); where.push(`j.id = $${params.length}`); }
  if (departmentId) { params.push(departmentId); where.push(`j.department_id = $${params.length}`); }
  if (managerId) { params.push(managerId); where.push(`j.hiring_manager_id = $${params.length}`); }
  const { rows } = await query(`SELECT ${JOB_COLUMNS} FROM jobs j JOIN departments d ON d.id = j.department_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY j.created_at DESC`, params);
  return rows.map(toJob);
}

// ---- Analytics snapshots --------------------------------------------------
async function saveSnapshot({ label, scope, metrics, takenBy }) {
  const { rows } = await query('INSERT INTO analytics_snapshots (label, scope, metrics, taken_by) VALUES ($1,$2,$3,$4) RETURNING *', [label, scope, metrics, takenBy]);
  return rows[0];
}
async function listSnapshots(limit = 20) {
  const { rows } = await query('SELECT id, label, scope, metrics, taken_by, taken_at FROM analytics_snapshots ORDER BY taken_at DESC LIMIT $1', [limit]);
  return rows.map((r) => ({ snapshotId: Number(r.id), label: r.label, scope: r.scope, metrics: r.metrics, takenBy: r.taken_by, takenAt: r.taken_at }));
}

module.exports = {
  listDepartments, getDepartment, createDepartment, deleteDepartment,
  getJob, searchJobs, createJob, updateJob, changeStatus, recordHire, jobHistory, jobsForScope,
  saveSnapshot, listSnapshots
};
