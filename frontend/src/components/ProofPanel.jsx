import React, { useEffect, useState } from 'react';
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
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { authFetch, downloadAuthorized } from '../api';
import { brand, formatFileSize, formatShopStamp } from '../brand';
import ProofStatusChip, { isProofHeld } from './ProofStatusChip';

async function openAuthorized(url) {
  const popup = window.open('', '_blank');
  try {
    const response = await authFetch(url);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Unable to open file');
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    if (popup) popup.location.href = objectUrl;
    else window.location.assign(objectUrl);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  } catch (err) {
    if (popup) popup.close();
    throw err;
  }
}

function noticeFor(email) {
  const status = email && email.status;
  if (status === 'sent') return 'Proof sent. The customer was emailed.';
  if (status === 'rate_limited') return 'Proof sent in Ignition. Too many emails. Try again later.';
  if (status === 'not_configured') return "Email isn't set up. The proof is still in Ignition.";
  if (status === 'failed') return 'Proof sent in Ignition. The email could not be sent.';
  return 'Proof sent in Ignition. No email was sent.';
}

function holdMessage(proofStatus, jobStatus) {
  if (!isProofHeld(proofStatus)) return '';
  if (String(jobStatus || '').trim().toLowerCase() === 'in-progress') {
    return 'This job is already In Production.';
  }
  return 'This job stays out of production until the proof is approved.';
}

export default function ProofPanel({
  orderId,
  workOrderId = null,
  jobStatus = null,
  canSend = false,
  canDecide = false,
  onChanged,
}) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [decidingId, setDecidingId] = useState(null);
  const [selected, setSelected] = useState([]);
  const [comments, setComments] = useState({});
  const [form, setForm] = useState({
    message: '',
    workOrderId: workOrderId ? String(workOrderId) : '',
    sendEmail: true,
    emailTo: '',
    emailCc: '',
  });

  async function load() {
    const response = await authFetch(`/api/orders/${orderId}/proofs`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Unable to load proofs');
    setPayload(body);
    return body;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load proofs');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  useEffect(() => {
    if (loading || window.location.hash !== '#proofs') return undefined;
    const node = document.getElementById('proofs');
    if (node) node.scrollIntoView({ block: 'start' });
    return undefined;
  }, [loading, orderId]);

  const proofs = (payload?.proofs || []).filter((proof) => {
    if (!workOrderId) return true;
    return proof.work_order_id == null || Number(proof.work_order_id) === Number(workOrderId);
  });
  const workOrders = payload?.work_orders || [];
  const scopedStatus = workOrderId
    ? (workOrders.find((row) => Number(row.id) === Number(workOrderId)) || {}).proof_status
    : null;
  const holdNote = holdMessage(scopedStatus, jobStatus);
  const commentsHistory = proofs.filter((proof) => proof.decided_at);
  const timeZone = payload?.timezone;
  const mail = payload?.mail;

  function openDialog() {
    setForm({
      message: '',
      workOrderId: workOrderId ? String(workOrderId) : '',
      sendEmail: Boolean(mail?.configured && mail?.default_send !== false),
      emailTo: mail?.to || '',
      emailCc: '',
    });
    setSelected([]);
    setError('');
    setDialogOpen(true);
  }

  async function sendProof(event) {
    event.preventDefault();
    if (!selected.length) {
      setError('Choose a file to upload');
      return;
    }
    if (!form.message.trim()) {
      setError('Enter a message for the customer');
      return;
    }
    setSending(true);
    setError('');
    try {
      const data = new FormData();
      selected.forEach((file) => data.append('files', file));
      data.append('message', form.message.trim());
      if (form.workOrderId) data.append('work_order_id', form.workOrderId);
      data.append('send_email', form.sendEmail ? 'true' : 'false');
      if (form.sendEmail && form.emailTo.trim()) data.append('email_to', form.emailTo.trim());
      if (form.sendEmail && form.emailCc.trim()) data.append('email_cc', form.emailCc.trim());
      const response = await authFetch(`/api/orders/${orderId}/proofs`, { method: 'POST', body: data });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to send proof');
      setDialogOpen(false);
      setNotice(noticeFor(body.email));
      await load();
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.message || 'Unable to send proof');
    } finally {
      setSending(false);
    }
  }

  async function approve(proof) {
    setDecidingId(proof.id);
    setError('');
    try {
      const response = await authFetch(`/api/proofs/${proof.id}/approve`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to approve this proof');
      setNotice(`Proof ${proof.version_label} approved.`);
      await load();
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.message || 'Unable to approve this proof');
    } finally {
      setDecidingId(null);
    }
  }

  async function requestChanges(proof) {
    const comment = String(comments[proof.id] || '').trim();
    if (!comment) {
      setError('A comment is required to request changes');
      return;
    }
    setDecidingId(proof.id);
    setError('');
    try {
      const response = await authFetch(`/api/proofs/${proof.id}/changes`, {
        method: 'POST',
        body: JSON.stringify({ comment }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to request changes');
      setNotice(`Changes requested on ${proof.version_label}.`);
      setComments((current) => ({ ...current, [proof.id]: '' }));
      await load();
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.message || 'Unable to request changes');
    } finally {
      setDecidingId(null);
    }
  }

  async function download(file) {
    setError('');
    try {
      await downloadAuthorized(`/api/proof-files/${file.id}/download`, file.original_name);
    } catch (err) {
      setError(err.message || 'Download failed');
    }
  }

  async function view(file) {
    setError('');
    try {
      await openAuthorized(`/api/proof-files/${file.id}/view`);
    } catch (err) {
      setError(err.message || 'Unable to open file');
    }
  }

  return (
    <Box id="proofs" data-testid="proof-panel" sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, overflow: 'hidden' }}>
      <Box sx={{ bgcolor: brand.navy, color: '#fff', px: 2, py: 1.25, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, flexWrap: 'wrap', borderBottom: `4px solid ${brand.orange}` }}>
        <Typography sx={{ fontWeight: 800, letterSpacing: '0.02em' }}>Proofs</Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          {scopedStatus ? <ProofStatusChip status={scopedStatus} testId="work-order-proof-status" /> : null}
          {canSend ? (
            <Button variant="contained" color="secondary" data-testid="send-proof-open" onClick={openDialog} sx={{ fontWeight: 800, width: { xs: '100%', sm: 'auto' } }}>
              Send proof
            </Button>
          ) : null}
        </Box>
      </Box>
      <Box sx={{ p: { xs: 1.5, sm: 2 }, display: 'grid', gap: 1.5 }}>
        {holdNote ? (
          <Alert severity="info">{holdNote}</Alert>
        ) : null}
        {loading ? <Typography color="text.secondary">Loading proofs...</Typography> : null}
        {error ? <Alert severity="error">{error}</Alert> : null}
        {notice ? <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert> : null}
        {!loading && proofs.length === 0 ? (
          <Typography color="text.secondary">No proofs yet.</Typography>
        ) : null}
        {proofs.map((proof) => {
          const busy = decidingId === proof.id;
          const awaiting = proof.status === 'awaiting';
          return (
            <Box key={proof.id} data-testid="proof-version" sx={{ border: `1px solid ${brand.border}`, borderRadius: 1, p: { xs: 1.25, sm: 1.5 }, minWidth: 0 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                <Typography sx={{ fontWeight: 800, color: brand.navy }}>
                  {proof.version_label}
                  {proof.work_order_number ? ` · ${proof.work_order_number}` : ' · Entire order'}
                </Typography>
                <ProofStatusChip status={proof.status} label={proof.status_label} />
              </Box>
              {proof.message ? (
                <Typography sx={{ mt: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{proof.message}</Typography>
              ) : null}
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                {proof.sender_name ? `${proof.sender_name} · ` : ''}
                {formatShopStamp(proof.created_at, timeZone) || proof.created_at}
              </Typography>
              {(proof.files || []).map((file) => (
                <Box key={file.id} sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, py: 0.75, flexWrap: 'wrap', alignItems: 'center', borderTop: `1px solid ${brand.border}`, mt: 1 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{file.original_name}</Typography>
                    <Typography variant="body2" color="text.secondary">{formatFileSize(file.size_bytes)}</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', width: { xs: '100%', sm: 'auto' } }}>
                    <Button size="small" data-testid="view-proof-file" onClick={() => view(file)} sx={{ color: brand.navy, fontWeight: 700, flex: { xs: 1, sm: 'none' } }}>
                      View
                    </Button>
                    <Button size="small" data-testid="download-proof-file" onClick={() => download(file)} sx={{ color: brand.navy, fontWeight: 700, flex: { xs: 1, sm: 'none' } }}>
                      Download
                    </Button>
                  </Box>
                </Box>
              ))}
              {canDecide && awaiting ? (
                <Box sx={{ display: 'grid', gap: 1, mt: 1.5 }}>
                  <Button
                    variant="contained"
                    data-testid="proof-approve"
                    disabled={busy}
                    onClick={() => approve(proof)}
                    sx={{ fontWeight: 800, bgcolor: brand.navy, width: { xs: '100%', sm: 'auto' }, justifySelf: 'start' }}
                  >
                    {busy ? 'Saving...' : 'Approve'}
                  </Button>
                  <TextField
                    label="What should change?"
                    value={comments[proof.id] || ''}
                    onChange={(event) => setComments((current) => ({ ...current, [proof.id]: event.target.value }))}
                    multiline
                    minRows={2}
                    required
                    data-testid="proof-comment"
                    placeholder="Required when you request changes"
                    fullWidth
                  />
                  <Button
                    variant="outlined"
                    data-testid="proof-request-changes"
                    disabled={busy}
                    onClick={() => requestChanges(proof)}
                    sx={{ fontWeight: 700, width: { xs: '100%', sm: 'auto' }, justifySelf: 'start' }}
                  >
                    Request changes
                  </Button>
                </Box>
              ) : null}
            </Box>
          );
        })}
        {commentsHistory.length ? (
          <Box data-testid="proof-comments">
            <Typography sx={{ color: brand.navy, fontWeight: 800, fontSize: 13, mb: 0.75 }}>CUSTOMER COMMENTS</Typography>
            {commentsHistory.map((proof) => (
              <Box key={`comment-${proof.id}`} sx={{ mb: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: 14, fontWeight: 700 }}>
                  {proof.version_label} · {proof.status_label}
                </Typography>
                <Typography sx={{ fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {proof.decision_comment || 'Approved with no comment.'}
                </Typography>
                <Typography sx={{ fontSize: 12, color: brand.muted }}>
                  {proof.decided_by_name || 'Customer'}
                  {' · '}
                  {formatShopStamp(proof.decided_at, timeZone) || proof.decided_at}
                </Typography>
              </Box>
            ))}
          </Box>
        ) : null}
      </Box>
      <Dialog open={dialogOpen} onClose={() => (sending ? null : setDialogOpen(false))} fullWidth maxWidth="sm" fullScreen={fullScreen}>
        <DialogTitle sx={{ color: brand.navy, fontWeight: 800, borderBottom: `4px solid ${brand.orange}` }}>
          Send proof
        </DialogTitle>
        <Box component="form" onSubmit={sendProof}>
          <DialogContent sx={{ display: 'grid', gap: 2 }}>
            {mail && !mail.configured ? (
              <Alert severity="warning">Email isn't set up. The proof is still shared in Ignition.</Alert>
            ) : null}
            {mail && mail.configured && mail.public_url_set === false ? (
              <Alert severity="info">The public app address is not set, so the email link may not open Ignition.</Alert>
            ) : null}
            <Button component="label" variant="outlined" sx={{ justifySelf: 'start', borderColor: brand.navy, color: brand.navy, width: { xs: '100%', sm: 'auto' } }}>
              Choose files
              <input
                hidden
                type="file"
                multiple
                data-testid="send-proof-input"
                onChange={(event) => setSelected(Array.from(event.target.files || []))}
              />
            </Button>
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {selected.length ? selected.map((file) => file.name).join(', ') : 'No files selected'}
            </Typography>
            <TextField
              label="Message"
              value={form.message}
              onChange={(event) => setForm({ ...form, message: event.target.value })}
              multiline
              minRows={2}
              required
              data-testid="send-proof-message"
              placeholder="Tell the customer what to review"
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
              label="Email the customer a sign-in link"
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
          <DialogActions sx={{ px: 3, pb: 2, flexDirection: { xs: 'column-reverse', sm: 'row' }, alignItems: 'stretch', gap: 1 }}>
            <Button onClick={() => setDialogOpen(false)} disabled={sending}>Cancel</Button>
            <Button type="submit" variant="contained" color="secondary" disabled={sending} data-testid="send-proof-submit" sx={{ fontWeight: 800 }}>
              {sending ? 'Sending...' : 'Send proof'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Box>
  );
}
