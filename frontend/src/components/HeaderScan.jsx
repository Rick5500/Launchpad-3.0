import React, { useEffect, useRef, useState } from 'react';
import { Alert, Box, InputBase, Snackbar } from '@mui/material';
import { authFetch } from '../api';
import { requestBoardRefresh } from '../boardEvents';

function isTypingTarget(node) {
  if (!node || node === document.body || node === document.documentElement) return false;
  const tag = node.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(node.isContentEditable);
}

function BarcodeMark() {
  const widths = [2, 1, 3, 1, 1, 2, 4, 1, 2, 1, 3, 1, 2];
  let cursor = 0;
  const bars = widths.map((width) => {
    const bar = { x: cursor, width };
    cursor += width + 1.2;
    return bar;
  });
  return (
    <Box
      component="svg"
      viewBox={`0 0 ${cursor} 28`}
      aria-hidden="true"
      sx={{ width: 34, height: 22, flexShrink: 0, display: { xs: 'none', sm: 'block' } }}
    >
      {bars.map((bar) => (
        <rect key={bar.x} x={bar.x} y="1" width={bar.width} height="26" fill="#0A2F6E" />
      ))}
    </Box>
  );
}

function noticeFor(body) {
  const label = body.external_id || 'Work order';
  if (body.department_moved && body.to_department) {
    return { severity: 'success', message: `${label} moved to ${body.to_department}` };
  }
  const where = body.to_department || body.from_department || 'the same department';
  return { severity: 'warning', message: `${label} stayed in ${where}` };
}

export default function HeaderScan({ user, autoFocus }) {
  const inputRef = useRef(null);
  const draftRef = useRef('');
  const queueRef = useRef([]);
  const drainingRef = useRef(false);
  const submittingRef = useRef(false);
  const userRef = useRef(user);
  const noticeSeq = useRef(0);
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState(null);

  userRef.current = user;

  function focusInput() {
    const node = inputRef.current;
    if (node && typeof node.focus === 'function') node.focus();
  }

  function setBusy(next) {
    submittingRef.current = next;
    setSubmitting(next);
  }

  function showNotice(next) {
    noticeSeq.current += 1;
    setNotice({ ...next, id: noticeSeq.current });
  }

  useEffect(() => {
    if (!autoFocus) return;
    if (isTypingTarget(document.activeElement)) return;
    focusInput();
  }, [autoFocus]);

  useEffect(() => {
    function onKey(event) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      focusInput();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function postBarcode(scanned) {
    try {
      const response = await authFetch('/api/barcode', {
        method: 'POST',
        body: JSON.stringify({
          scanned_value: scanned,
          location: userRef.current?.department || null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        showNotice({
          severity: 'error',
          message: response.status === 404 ? 'Unknown barcode' : (body.error || 'Scan failed'),
        });
        return;
      }
      showNotice(noticeFor(body));
      requestBoardRefresh();
    } catch (err) {
      showNotice({ severity: 'error', message: err.message || 'Scan failed' });
    }
  }

  async function drain() {
    try {
      while (queueRef.current.length) {
        const scanned = queueRef.current.shift();
        await postBarcode(scanned);
      }
    } finally {
      if (queueRef.current.length) {
        void drain();
        return;
      }
      drainingRef.current = false;
      if (queueRef.current.length) {
        drainingRef.current = true;
        void drain();
        return;
      }
      setBusy(false);
      focusInput();
    }
  }

  function enqueue(raw) {
    const scanned = String(raw || '').trim();
    draftRef.current = '';
    setValue('');
    focusInput();
    if (!scanned) return;
    queueRef.current.push(scanned);
    if (drainingRef.current) return;
    drainingRef.current = true;
    setBusy(true);
    void drain();
  }

  function submit(event) {
    event.preventDefault();
    const scanned = draftRef.current || (inputRef.current && inputRef.current.value) || '';
    enqueue(scanned);
  }

  function onKeyDown(event) {
    if (!submittingRef.current) return;
    if (event.key === 'Enter' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Backspace') {
      event.preventDefault();
      draftRef.current = draftRef.current.slice(0, -1);
      setValue(draftRef.current);
      return;
    }
    if (event.key.length !== 1) return;
    event.preventDefault();
    draftRef.current += event.key;
    setValue(draftRef.current);
  }

  return (
    <>
      <Box
        component="form"
        onSubmit={submit}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          width: '100%',
          bgcolor: '#fff',
          border: '1px solid #D5DDE8',
          borderRadius: 999,
          px: 1.25,
          py: 0.35,
          '&:focus-within': {
            borderColor: '#1565C0',
            boxShadow: '0 0 0 3px rgba(21,101,192,0.28)',
          },
        }}
      >
        <BarcodeMark />
        <InputBase
          inputRef={inputRef}
          value={value}
          onChange={(event) => {
            draftRef.current = event.target.value;
            setValue(event.target.value);
          }}
          onKeyDown={onKeyDown}
          placeholder="Scan barcode"
          readOnly={submitting}
          inputProps={{
            'aria-label': 'Scan barcode',
            'aria-keyshortcuts': 'Alt+S',
            title: 'Scan barcode (Alt+S)',
            autoComplete: 'off',
            autoCapitalize: 'off',
            spellCheck: 'false',
          }}
          sx={{ flex: 1, fontSize: 15, minWidth: 0 }}
        />
        <BarcodeMark />
      </Box>
      <Snackbar
        key={notice ? notice.id : 'scan-notice'}
        open={Boolean(notice)}
        autoHideDuration={4000}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        sx={{ mt: 7 }}
      >
        <Alert
          severity={notice?.severity || 'info'}
          variant="filled"
          onClose={() => setNotice(null)}
          sx={{ width: '100%' }}
        >
          {notice?.message}
        </Alert>
      </Snackbar>
    </>
  );
}
