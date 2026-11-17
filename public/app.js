const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  timezone: 'Asia/Kolkata',
  scheduleType: 'once',
  editingScheduleId: null,
  schedules: [],
  schedulesById: new Map(),
  scheduleSort: { key: null, direction: 1 },
  toastTimer: undefined,
  recipientTimer: undefined,
  previewTimer: undefined,
  cronTimer: undefined,
};

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') showLogin();
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
  return payload;
}

function showToast(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('is-error', isError);
  toast.classList.add('is-visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

function showLogin() {
  $('#loginView').hidden = false;
  $('#appView').hidden = true;
  $('#sessionActions').hidden = true;
  $('#connectionLabel').textContent = 'Sign in to connect';
  $('#connectionPill').dataset.state = 'connecting';
}

function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  $('#sessionActions').hidden = false;
  refreshAll();
}

function updateConnection(status) {
  state.timezone = status.timezone || state.timezone;
  $('#timezoneLabel').textContent = state.timezone;
  $('#serverClock').textContent = `${status.localTime || '--'} · ${state.timezone}`;

  const label = $('#connectionLabel');
  const pill = $('#connectionPill');
  const notice = $('#connectionNotice');
  const noticeTitle = $('#noticeTitle');
  const noticeCopy = $('#noticeCopy');
  const noticeState = $('#noticeState');
  const qrPanel = $('#qrPanel');
  const statusName = status.connectionState;

  pill.dataset.state = statusName === 'connected' ? 'connected' : statusName === 'disconnected' ? 'disconnected' : 'connecting';
  if (statusName === 'connected') {
    label.textContent = `Connected${status.connectedUser?.name ? ` as ${status.connectedUser.name}` : ''}`;
    notice.hidden = true;
  } else {
    label.textContent = statusName === 'qr_ready' ? 'Scan QR to connect' : statusName === 'disconnected' ? 'Reconnecting' : 'Connecting';
    notice.hidden = false;
    noticeTitle.textContent = statusName === 'qr_ready' ? 'WhatsApp needs to be linked' : statusName === 'disconnected' ? 'WhatsApp disconnected' : 'WhatsApp is connecting';
    noticeCopy.textContent = statusName === 'qr_ready' ? 'Scan the code below with Linked devices.' : 'Pair a device to start scheduling messages.';
    noticeState.textContent = statusName === 'qr_ready' ? 'Scan QR' : statusName === 'disconnected' ? 'Reconnecting' : 'Connecting';
  }

  qrPanel.hidden = statusName !== 'qr_ready' || !status.qrDataUrl;
  if (status.qrDataUrl && statusName === 'qr_ready') $('#qrImage').src = status.qrDataUrl;
  else $('#qrImage').removeAttribute('src');
}

function formatTime(epochMs) {
  if (!epochMs) return '—';
  return new Intl.DateTimeFormat(undefined, {
    timeZone: state.timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(epochMs));
}

function appendCell(row, text, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text;
  row.append(cell);
  return cell;
}

function makeAction(label, action, id, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.id = id;
  if (className) button.className = className;
  return button;
}

function compareSchedules(left, right, key) {
  if (key === 'when') {
    const leftIsDated = left.schedule_type === 'once';
    const rightIsDated = right.schedule_type === 'once';
    if (leftIsDated !== rightIsDated) return leftIsDated ? -1 : 1;
    const leftValue = leftIsDated ? left.run_at_ms : left.cron_expr;
    const rightValue = rightIsDated ? right.run_at_ms : right.cron_expr;
    return typeof leftValue === 'number'
      ? leftValue - rightValue
      : String(leftValue || '').localeCompare(String(rightValue || ''), undefined, { sensitivity: 'base', numeric: true });
  }

  const leftValue = key === 'recipient'
    ? (left.recipient_name || left.recipient_jid)
    : (left.label || '');
  const rightValue = key === 'recipient'
    ? (right.recipient_name || right.recipient_jid)
    : (right.label || '');
  if (!leftValue || !rightValue) return leftValue ? -1 : rightValue ? 1 : 0;
  return String(leftValue).localeCompare(String(rightValue), undefined, { sensitivity: 'base', numeric: true });
}

function updateScheduleSortHeaders() {
  for (const header of $$('[data-sort-key]')) {
    const key = header.dataset.sortKey;
    const isActive = state.scheduleSort.key === key;
    header.setAttribute('aria-sort', isActive
      ? (state.scheduleSort.direction === 1 ? 'ascending' : 'descending')
      : 'none');
    const indicator = $('[data-sort-indicator]', header);
    indicator.textContent = isActive ? (state.scheduleSort.direction === 1 ? '↑' : '↓') : '';
  }
}

function renderSchedules(schedules) {
  const rows = $('#scheduleRows');
  state.schedules = schedules;
  state.schedulesById = new Map(schedules.map((schedule) => [String(schedule.id), schedule]));
  rows.replaceChildren();
  $('#scheduleCount').textContent = String(schedules.length);
  $('#emptySchedules').hidden = schedules.length > 0;
  updateScheduleSortHeaders();

  const visibleSchedules = state.scheduleSort.key
    ? [...schedules].sort((left, right) => {
      const comparison = compareSchedules(left, right, state.scheduleSort.key);
      const isDatedVsRecurring = state.scheduleSort.key === 'when'
        && (left.schedule_type === 'once') !== (right.schedule_type === 'once');
      return isDatedVsRecurring ? comparison : comparison * state.scheduleSort.direction;
    })
    : schedules;
  for (const schedule of visibleSchedules) {
    const row = document.createElement('tr');
    appendCell(row, schedule.recipient_name || schedule.recipient_jid, 'recipient-cell');
    appendCell(row, schedule.label || '—', 'schedule-label');
    const when = schedule.schedule_type === 'once'
      ? formatTime(schedule.run_at_ms)
      : `Cron · ${schedule.cron_expr}`;
    appendCell(row, when, 'schedule-time');
    appendCell(row, schedule.message_template, 'schedule-message');

    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'status-badge';
    badge.dataset.status = schedule.status;
    badge.textContent = schedule.status === 'processing' ? 'Sending' : schedule.status;
    statusCell.append(badge);
    row.append(statusCell);

    const actions = document.createElement('td');
    actions.className = 'row-actions';
    if (['active', 'paused'].includes(schedule.status)) {
      actions.append(makeAction('Edit', 'edit', schedule.id));
      actions.append(makeAction('Run now', 'run', schedule.id));
      actions.append(makeAction(schedule.status === 'active' ? 'Pause' : 'Resume', 'toggle', schedule.id));
    }
    actions.append(makeAction('Delete', 'delete', schedule.id, 'delete-action'));
    row.append(actions);
    rows.append(row);
  }
}

function statusText(status) {
  return ({ sent: 'Sent to WhatsApp', error: 'Error', unknown: 'Outcome unknown', sending: 'Sending' })[status] || status;
}

function renderLogs(logs) {
  const rows = $('#logRows');
  rows.replaceChildren();
  $('#logCount').textContent = String(logs.length);
  $('#emptyLogs').hidden = logs.length > 0;
  for (const log of logs) {
    const row = document.createElement('tr');
    appendCell(row, formatTime(log.executed_at_ms));
    appendCell(row, log.recipient_name || log.recipient_jid);
    appendCell(row, log.rendered_message, 'logs-message');
    const result = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'status-badge';
    badge.dataset.status = log.status;
    badge.textContent = statusText(log.status);
    result.append(badge);
    row.append(result);
    rows.append(row);
  }
}

async function refreshStatus() {
  const status = await api('/status');
  updateConnection(status);
}

async function refreshLists() {
  const [schedules, logs] = await Promise.all([api('/schedules'), api('/logs?limit=50')]);
  renderSchedules(schedules);
  renderLogs(logs);
}

async function refreshAll() {
  try {
    await Promise.all([refreshStatus(), refreshLists()]);
  } catch (error) {
    if (error.message !== 'Authentication required.') showToast(error.message, true);
  }
}

function setScheduleType(type) {
  state.scheduleType = type;
  for (const button of $$('[data-schedule-type]')) {
    const selected = button.dataset.scheduleType === type;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  $('#onceFields').hidden = type !== 'once';
  $('#cronFields').hidden = type !== 'cron';
  $('#runAtInput').required = type === 'once';
  $('#cronInput').required = type === 'cron';
}

function resetScheduleForm() {
  state.editingScheduleId = null;
  $('#scheduleForm').reset();
  $('#labelInput').value = '';
  $('#recipientInput').value = '';
  $('#recipientValue').value = '';
  $('#recipientOptions').hidden = true;
  $('#jitterInput').value = '0';
  $('#cronPreset').value = 'custom';
  setScheduleType('once');
  $('#messagePreview').textContent = 'Your rendered message will appear here.';
  $('#previewTime').textContent = '';
  $('#composeTitle').textContent = 'Create a schedule';
  $('#composeTitle').previousElementSibling.textContent = 'NEW MESSAGE';
  $('#scheduleSubmitButton').textContent = 'Schedule message';
  $('#cancelEditButton').hidden = true;
}

function editSchedule(schedule) {
  state.editingScheduleId = schedule.id;
  $('#labelInput').value = schedule.label;
  $('#recipientInput').value = schedule.recipient_name || schedule.recipient_jid;
  $('#recipientValue').value = schedule.recipient_jid;
  $('#messageInput').value = schedule.message_template;
  $('#jitterInput').value = String(schedule.jitter_max_sec);
  setScheduleType(schedule.schedule_type);
  if (schedule.schedule_type === 'once') {
    const parts = dateParts(new Date(schedule.run_at_ms), state.timezone);
    $('#runAtInput').value = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } else {
    $('#cronInput').value = schedule.cron_expr;
    $('#cronPreset').value = [...$('#cronPreset').options].some((option) => option.value === schedule.cron_expr)
      ? schedule.cron_expr
      : 'custom';
    clearTimeout(state.cronTimer);
    state.cronTimer = setTimeout(validateCron, 120);
  }
  $('#composeTitle').textContent = 'Edit schedule';
  $('#composeTitle').previousElementSibling.textContent = 'EDIT SCHEDULE';
  $('#scheduleSubmitButton').textContent = 'Save changes';
  $('#cancelEditButton').hidden = false;
  updatePreview();
  $('#composeTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function dateParts(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function setQuickTime(offset) {
  const date = new Date(Date.now() + offset);
  const parts = dateParts(date, state.timezone);
  $('#runAtInput').value = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function setTomorrow() {
  const current = dateParts(new Date(), state.timezone);
  const next = new Date(Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day) + 1));
  const year = next.getUTCFullYear();
  const month = String(next.getUTCMonth() + 1).padStart(2, '0');
  const day = String(next.getUTCDate()).padStart(2, '0');
  $('#runAtInput').value = `${year}-${month}-${day}T09:00`;
}

async function loadRecipients(query) {
  try {
    const chats = await api(`/chats?q=${encodeURIComponent(query)}`);
    const options = $('#recipientOptions');
    options.replaceChildren();
    if (!chats.length) {
      options.hidden = true;
      return;
    }
    for (const chat of chats.slice(0, 12)) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'recipient-option';
      option.role = 'option';
      option.dataset.jid = chat.jid;
      option.dataset.name = chat.name;
      const name = document.createElement('span');
      name.textContent = chat.name;
      const type = document.createElement('span');
      type.className = 'recipient-type';
      type.textContent = chat.type;
      option.append(name, type);
      options.append(option);
    }
    options.hidden = false;
  } catch (error) {
    if (error.message !== 'Authentication required.') showToast(error.message, true);
  }
}

async function updatePreview() {
  const template = $('#messageInput').value;
  if (!template.trim()) {
    $('#messagePreview').textContent = 'Your rendered message will appear here.';
    $('#previewTime').textContent = '';
    return;
  }
  try {
    const preview = await api('/preview', { method: 'POST', body: { messageTemplate: template } });
    $('#messagePreview').textContent = preview.renderedMessage;
    $('#previewTime').textContent = `${preview.localTime} · ${state.timezone}`;
  } catch (error) {
    $('#messagePreview').textContent = error.message;
  }
}

async function validateCron() {
  const expression = $('#cronInput').value.trim();
  const feedback = $('#cronFeedback');
  if (!expression) {
    feedback.textContent = 'Enter a five-field expression.';
    feedback.className = 'cron-feedback';
    return;
  }
  try {
    const result = await api('/cron/validate', { method: 'POST', body: { cronExpr: expression } });
    feedback.textContent = result.valid ? `Valid · ${state.timezone}` : 'Invalid cron expression.';
    feedback.className = `cron-feedback ${result.valid ? 'is-valid' : 'is-invalid'}`;
  } catch (error) {
    feedback.textContent = error.message;
    feedback.className = 'cron-feedback is-invalid';
  }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  try {
    await api('/auth/login', { method: 'POST', body: { password: $('#passwordInput').value } });
    $('#passwordInput').value = '';
    showApp();
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
});

$('#signOutButton').addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST', body: {} });
    showLogin();
  } catch (error) {
    showToast(error.message, true);
  }
});

$('#unlinkButton').addEventListener('click', async () => {
  if (!window.confirm('Unlink this WhatsApp account and require a new QR scan?')) return;
  try {
    await api('/logout', { method: 'POST', body: {} });
    showToast('WhatsApp unlinked. A new QR code will appear shortly.');
    refreshStatus();
  } catch (error) {
    showToast(error.message, true);
  }
});

$('#syncButton').addEventListener('click', async () => {
  try {
    const result = await api('/sync-chats', { method: 'POST', body: {} });
    await loadRecipients('');
    showToast(`Synced ${result.syncedGroups} groups.`);
  } catch (error) {
    showToast(error.message, true);
  }
});

for (const button of $$('[data-schedule-type]')) {
  button.addEventListener('click', () => setScheduleType(button.dataset.scheduleType));
}

for (const button of $$('[data-offset]')) {
  button.addEventListener('click', () => {
    if (button.dataset.offset === 'tomorrow') setTomorrow();
    else setQuickTime(Number(button.dataset.offset));
  });
}

$('#cronPreset').addEventListener('change', () => {
  if ($('#cronPreset').value !== 'custom') $('#cronInput').value = $('#cronPreset').value;
  clearTimeout(state.cronTimer);
  state.cronTimer = setTimeout(validateCron, 120);
});

$('#cronInput').addEventListener('input', () => {
  $('#cronPreset').value = 'custom';
  clearTimeout(state.cronTimer);
  state.cronTimer = setTimeout(validateCron, 250);
});

$('#messageInput').addEventListener('input', () => {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(updatePreview, 250);
});

$('#recipientInput').addEventListener('input', () => {
  $('#recipientValue').value = $('#recipientInput').value.trim();
  clearTimeout(state.recipientTimer);
  state.recipientTimer = setTimeout(() => loadRecipients($('#recipientInput').value.trim()), 180);
});

$('#recipientOptions').addEventListener('click', (event) => {
  const option = event.target.closest('.recipient-option');
  if (!option) return;
  $('#recipientInput').value = option.dataset.name;
  $('#recipientValue').value = option.dataset.jid;
  $('#recipientOptions').hidden = true;
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.recipient-wrap')) $('#recipientOptions').hidden = true;
});

for (const button of $$('[data-variable]')) {
  button.addEventListener('click', () => {
    const input = $('#messageInput');
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.setRangeText(button.dataset.variable, start, end, 'end');
    input.focus();
    input.dispatchEvent(new Event('input'));
  });
}

$('#scheduleForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    label: $('#labelInput').value,
    recipient: $('#recipientValue').value,
    messageTemplate: $('#messageInput').value,
    scheduleType: state.scheduleType,
    jitterMaxSec: Number($('#jitterInput').value),
  };
  if (state.scheduleType === 'once') payload.runAt = $('#runAtInput').value;
  else payload.cronExpr = $('#cronInput').value;

  try {
    const editing = state.editingScheduleId !== null;
    const path = editing ? `/schedules/${state.editingScheduleId}` : '/schedules';
    await api(path, { method: editing ? 'PATCH' : 'POST', body: payload });
    resetScheduleForm();
    await refreshLists();
    showToast(editing ? 'Schedule updated.' : 'Schedule created.');
  } catch (error) {
    showToast(error.message, true);
  }
});

$('#cancelEditButton').addEventListener('click', resetScheduleForm);

$('#scheduleRows').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  if (action === 'edit') {
    const schedule = state.schedulesById.get(id);
    if (schedule) editSchedule(schedule);
    else showToast('Schedule not found. Refresh and try again.', true);
    return;
  }
  try {
    if (action === 'run') {
      if (!window.confirm('Run this schedule now? This sends a real WhatsApp message.')) return;
      const result = await api(`/schedules/${id}/run-now`, { method: 'POST', body: {} });
      showToast(result.unknown ? 'Send outcome is unknown. Check WhatsApp before retrying.' : 'Message accepted by WhatsApp.');
    } else if (action === 'toggle') {
      await api(`/schedules/${id}/toggle`, { method: 'PATCH', body: {} });
      showToast('Schedule updated.');
    } else if (action === 'delete') {
      if (!window.confirm('Delete this schedule?')) return;
      await api(`/schedules/${id}`, { method: 'DELETE' });
      showToast('Schedule deleted.');
    }
    await refreshLists();
  } catch (error) {
    showToast(error.message, true);
  }
});

$('#scheduleTable').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-sort-key]');
  if (!button) return;
  const key = button.dataset.sortKey;
  state.scheduleSort.direction = state.scheduleSort.key === key ? -state.scheduleSort.direction : 1;
  state.scheduleSort.key = key;
  renderSchedules(state.schedules);
});

async function initialize() {
  try {
    await api('/auth/session');
    showApp();
  } catch {
    showLogin();
  }
}

initialize();
setInterval(() => {
  if (!$('#appView').hidden) refreshStatus().catch(() => {});
}, 3000);
setInterval(() => {
  if (!$('#appView').hidden) refreshLists().catch(() => {});
}, 10000);