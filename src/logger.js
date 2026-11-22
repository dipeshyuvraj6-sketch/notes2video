function log(jobId, stage, status, ms, meta) {
  const entry = { ts: new Date().toISOString(), jobId, stage, status };
  if (ms !== undefined) entry.ms = ms;
  if (meta) entry.meta = meta;
  const output = JSON.stringify(entry);
  if (status === 'error') console.error(output);
  else console.log(output);
  return entry;
}

module.exports = { log };
