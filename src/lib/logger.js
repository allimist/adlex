function line(level, obj) {
  const rec = { t: new Date().toISOString(), level, ...(typeof obj === 'string' ? { msg: obj } : obj) };
  const out = JSON.stringify(rec);
  if (level === 'error') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

export const logger = {
  info: (o) => line('info', o),
  warn: (o) => line('warn', o),
  error: (o) => line('error', o),
};
