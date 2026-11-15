export function getTimezone() {
  return process.env.TZ || 'Asia/Kolkata';
}

export function parseLocalDateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    throw new Error('Enter a valid local date and time.');
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Enter a valid local date and time.');
  }

  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  if (
    date.getFullYear() !== year ||
    date.getMonth() + 1 !== month ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    throw new Error('That local time does not exist in the configured timezone.');
  }

  return date;
}

export function formatLocalDateTime(date = new Date(), timeZone = getTimezone()) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function renderMessage(template, date = new Date(), timeZone = getTimezone(), random = Math.random) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(date);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);

  return template
    .replace(/\{\{random:([^{}]+)}}/g, (_, choices) => {
      const options = choices.split('|').map((option) => option.trim()).filter(Boolean);
      if (!options.length) return '';
      return options[Math.min(Math.floor(random() * options.length), options.length - 1)];
    })
    .replaceAll('{{date}}', parts)
    .replaceAll('{{day}}', day)
    .replaceAll('{{time}}', time);
}