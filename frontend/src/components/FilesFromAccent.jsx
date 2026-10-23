import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { authFetch, downloadAuthorized } from '../api';
import { brand, formatFileSize, formatShopStamp } from '../brand';

function downloadLabel(file, timeZone) {
  if (!file.customer_downloaded_at) return 'Not downloaded by the customer';
  const stamp = formatShopStamp(file.customer_downloaded_at, timeZone);
  return stamp ? `Downloaded by customer · ${stamp}` : 'Downloaded by customer';
}

export default function FilesFromAccent({ orderId, workOrderId = null, canManage = false }) {
  const replaceRef = useRef(null);
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [replacingId, setReplacingId] = useState(null);
  const [selected, setSelected] = useState([]);
  const [form, setForm] = useState({
    message: '',
    workOrderId: workOrderId ? String(workOrderId) : '',
    sendEmail: true,
    emailTo: '',
    emailCc: '',
  });

  const query = workOrderId ? `?work_order_id=${encodeURIComponent(workOrderId)}` : '';

  async function load() {
    const response = await authFetch(`/api/orders/${orderId}/shared-files${query}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Unable to load files');
    setPayload(body);
    return body;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load files');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orderId, workOrderId]);

  const groups = useMemo(() => {
    const files = payload?.files || [];
    const grouped = [];
    for (const file of files) {
      const key = file.batch_id || `file-${file.id}`;
      const last = grouped[grouped.length - 1];
      if (last && last.key === key) last.files.push(file);
      else grouped.push({ key, message: file.message, created_at: file.created_at, files: [file] });
    }
    return grouped;
  }, [payload]);

  function openDialog() {
    const mail = payload?.mail || {};
    setForm({
      message: '',
      workOrderId: workOrderId ? String(workOrderId) : '',
      sendEmail: Boolean(mail.configured && mail.default_send !== false),
      emailTo: mail.to || '',
      emailCc: '',
    });
    setSelected([]);
    setError('');
    setDialogOpen(true);
  }

  function noticeFor(email, configured) {
    const status = email && email.status;
    if (status === 'sent') return 'Files sent. The customer was emailed.';
    if (status === 'rate_limited') return 'Files shared in Launchpad. Too many emails. Try again later.';
    if (status === 'not_configured' || configured === false) return "Email isn't set up. Files are still shared in Launchpad.";
    if (status === 'failed') return 'Files shared in Launchpad. The email could not be sent.';
    return 'Files shared in Launchpad. No email was sent.';
  }

  async function sendFiles(event) {
    event.preventDefault();
    if (!selected.length) {
      setError('Choose a file to upload');
      return;
    }
    setSending(true);
    setError('');
    try {
      const data = new FormData();
      selected.forEach((file) => data.append('files', file));
      if (form.message.trim()) data.append('message', form.message.trim());
      if (form.workOrderId) data.append('work_order_id', form.workOrderId);
      data.append('send_email', form.sendEmail ? 'true' : 'false');
      if (form.sendEmail && form.emailTo.trim()) data.append('email_to', form.emailTo.trim());
      if (form.sendEmail && form.emailCc.trim()) data.append('email_cc', form.emailCc.trim());
      const response = await authFetch(`/api/orders/${orderId}/shared-files`, { method: 'POST', body: data });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to share files');
      setDialogOpen(false);
      setNotice(noticeFor(body.email, Boolean(payload?.mail?.configured)));
      await load();
    } catch (err) {
      setError(err.message || 'Unable to share files');
    } finally {
      setSending(false);
    }
  }

  async function removeFile(file) {
    if (!window.confirm(`Remove ${file.original_name} from the customer? The activity log keeps the record.`)) return;
    setError('');
    const response = await authFetch(`/api/shared-files/${file.id}`, { method: 'DELETE' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error || 'Unable to remove file');
      return;
    }
    setNotice('File removed.');
    await load().catch((err) => setError(err.message || 'Unable to load files'));
  }

  function startReplace(file) {
    setReplacingId(file.id);
    replaceRef.current.value = '';
    replaceRef.current.click();
  }

  async function onReplace(event) {
    const file = event.target.files && event.target.files[0];
    const id = replacingId;
    setReplacingId(null);
    if (!file || !id) return;
    setError('');
    try {
      const data = new FormData();
      data.append('files', file);
      const response = await authFetch(`/api/shared-files/${id}/replace`, { method: 'POST', body: data });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to replace file');
      setNotice('File replaced.');
      await load();
    } catch (err) {
      setError(err.message || 'Unable to replace file');
    }
  }

  async function download(file) {
    setError('');
    try {
      await downloadAuthorized(`/api/shared-files/${file.id}/download`, file.original_name);
      if (!canManage) await load();
    } catch (err) {
      setError(err.message || 'Download failed');
    }
  }

  const mail = payload?.mail;
  const timeZone = payload?.timezone;
  const workOrders = payload?.work_orders || [];

  return (
    <Box id="files-from-accent" data-testid="files-from-accent" sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, overflow: 'hidden' }}>
      <Box sx={{ bgcolor: brand.navy, color: '#fff', px: 2, py: 1.25, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, flexWrap: 'wrap', borderBottom: `4px solid ${brand.orange}` }}>
        <Typography sx={{ fontWeight: 800, letterSpacing: '0.02em' }}>Files from Accent</Typography>
        {canManage ? (
          <Button variant="contained" color="secondary" data-testid="send-files-open" onClick={openDialog} sx={{ fontWeight: 800 }}>
            Send files
          </Button>
        ) : null}
      </Box>
      <Box sx={{ p: 2, display: 'grid', gap: 1.5 }}>
        {loading ? <Typography color="text.secondary">Loading files...</Typography> : null}
        {error ? <Alert severity="error">{error}</Alert> : null}
        {notice ? <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert> : null}
        {!loading && groups.length === 0 ? (
          <Typography color="text.secondary">No files from Accent yet.</Typography>
        ) : null}
        {groups.map((group) => (
          <Box key={group.key} sx={{ border: `1px solid ${brand.border}`, borderRadius: 1, p: 1.5 }}>
            {group.message ? (
              <Typography sx={{ mb: 1, whiteSpace: 'pre-wrap' }}>{group.message}</Typography>
            ) : null}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              {formatShopStamp(group.created_at, timeZone) || group.created_at}
            </Typography>
            {group.files.map((file) => (
              <Box key={file.id} data-testid="shared-file-row" sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, py: 0.75, flexWrap: 'wrap', borderTop: `1px solid ${brand.border}` }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography data-testid="shared-file-name" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
                    {file.original_name}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {formatFileSize(file.size_bytes)}
                    {file.work_order_number ? ` · ${file.work_order_number}` : ' · Entire order'}
                  </Typography>
                  {canManage || file.customer_downloaded_at ? (
                    <Typography variant="body2" data-testid="customer-download-state" sx={{ color: file.downloaded_by_customer ? brand.greenDark : brand.muted }}>
                      {downloadLabel(file, timeZone)}
                    </Typography>
                  ) : null}
                </Box>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  <Button size="small" data-testid="download-shared-file" onClick={() => download(file)} sx={{ color: brand.navy, fontWeight: 700 }}>
                    Download
                  </Button>
                  {canManage ? (
                    <>
                      <Button size="small" onClick={() => startReplace(file)} sx={{ fontWeight: 700 }}>Replace</Button>
                      <Button size="small" color="error" onClick={() => removeFile(file)} sx={{ fontWeight: 700 }}>Remove</Button>
                    </>
                  ) : null}
                </Box>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
      <input ref={replaceRef} type="file" hidden onChange={onReplace} />
      <Dialog open={dialogOpen} onClose={() => (sending ? null : setDialogOpen(false))} fullWidth maxWidth="sm" data-testid="send-files-dialog">
        <DialogTitle sx={{ color: brand.navy, fontWeight: 800, borderBottom: `4px solid ${brand.orange}` }}>
          Send files
        </DialogTitle>
        <Box component="form" onSubmit={sendFiles}>
          <DialogContent sx={{ display: 'grid', gap: 2 }}>
            {mail && !mail.configured ? (
              <Alert severity="warning">Email isn't set up. Files are still shared in Launchpad.</Alert>
            ) : null}
            {mail && mail.configured && mail.public_url_set === false ? (
              <Alert severity="info">The public app address is not set, so the email link may not open Launchpad.</Alert>
            ) : null}
            <Button component="label" variant="outlined" sx={{ justifySelf: 'start', borderColor: brand.navy, color: brand.navy }}>
              Choose files
              <input
                hidden
                type="file"
                multiple
                data-testid="send-files-input"
                onChange={(event) => setSelected(Array.from(event.target.files || []))}
              />
            </Button>
            <Typography variant="body2" color="text.secondary" data-testid="send-files-names">
              {selected.length ? selected.map((file) => file.name).join(', ') : 'No files selected'}
            </Typography>
            <TextField
              label="Message"
              value={form.message}
              onChange={(event) => setForm({ ...form, message: event.target.value })}
              multiline
              minRows={2}
              placeholder="Optional note for the customer"
            />
            <TextField
              select
              label="Work order"
              value={form.workOrderId}
              onChange={(event) => setForm({ ...form, workOrderId: event.target.value })}
            >
              <MenuItem value="">Entire order</MenuItem>
              {workOrders.map((row) => (
                <MenuItem key={row.id} value={String(row.id)}>
                  {row.external_id}{row.service_name ? ` · ${row.service_name}` : ''}
                </MenuItem>
              ))}
            </TextField>
            <FormControlLabel
              control={(
                <Checkbox
                  checked={form.sendEmail}
                  disabled={!mail || !mail.configured}
                  onChange={(event) => setForm({ ...form, sendEmail: event.target.checked })}
                />
              )}
              label="Email the customer"
            />
            <TextField
              label="To"
              value={form.emailTo}
              onChange={(event) => setForm({ ...form, emailTo: event.target.value })}
              disabled={!form.sendEmail}
              helperText="Defaults to the order contact email."
            />
            <TextField
              label="CC"
              value={form.emailCc}
              onChange={(event) => setForm({ ...form, emailCc: event.target.value })}
              disabled={!form.sendEmail}
              helperText="Optional. Separate addresses with commas."
            />
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setDialogOpen(false)} disabled={sending}>Cancel</Button>
            <Button type="submit" variant="contained" color="secondary" disabled={sending} data-testid="send-files-submit" sx={{ fontWeight: 800 }}>
              {sending ? 'Sending...' : 'Send files'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Box>
  );
}
