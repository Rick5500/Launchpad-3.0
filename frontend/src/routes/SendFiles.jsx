import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  TextField,
  Typography,
} from '@mui/material';
import { authFetch } from '../api';
import { brand } from '../brand';
import FileTransferList from '../components/FileTransferList';
import Pager from '../components/Pager';

function customerLabel(option) {
  if (!option) return '';
  return option.display_name || option.company || option.username || '';
}

function noticeFor(email, configured) {
  const status = email && email.status;
  if (status === 'sent') return 'Files sent. The customer was emailed.';
  if (status === 'rate_limited') return 'Files shared in Ignition. Too many emails. Try again later.';
  if (status === 'not_configured' || configured === false) return "Email isn't set up. Files are still shared in Ignition.";
  if (status === 'failed') return 'Files shared in Ignition. The email could not be sent.';
  return 'Files shared in Ignition. No email was sent.';
}

export default function SendFiles() {
  const [customers, setCustomers] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [filterCustomer, setFilterCustomer] = useState(null);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState([]);
  const [sendEmail, setSendEmail] = useState(true);
  const [emailTo, setEmailTo] = useState('');
  const [emailCc, setEmailCc] = useState('');
  const [payload, setPayload] = useState(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const limit = 20;

  async function loadTransfers(nextOffset = offset, customerId = filterCustomer && filterCustomer.id) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(nextOffset) });
    if (customerId) params.set('customer_id', String(customerId));
    const response = await authFetch(`/api/file-transfers?${params}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Unable to load sent files');
    setPayload(body);
    return body;
  }

  useEffect(() => {
    let cancelled = false;
    authFetch('/api/customers/lookup')
      .then(async (response) => {
        const body = await response.json().catch(() => ([]));
        if (!response.ok) throw new Error(body.error || 'Unable to load customers');
        if (!cancelled) setCustomers(Array.isArray(body) ? body : []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load customers');
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadTransfers(offset, filterCustomer && filterCustomer.id)
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load sent files');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [offset, filterCustomer]);

  const mail = payload?.mail;
  const transfers = payload?.transfers || [];
  const configured = Boolean(mail && mail.configured);

  useEffect(() => {
    if (!mail) return;
    setSendEmail(Boolean(mail.configured && mail.default_send !== false));
  }, [mail && mail.configured, mail && mail.default_send]);

  const fileNames = useMemo(() => files.map((file) => file.name).join(', '), [files]);

  function chooseCustomer(_, value) {
    setCustomer(value);
    setEmailTo(value && value.email ? value.email : '');
  }

  async function sendFiles(event) {
    event.preventDefault();
    if (!customer) {
      setError('Choose a customer');
      return;
    }
    if (!files.length) {
      setError('Choose a file to upload');
      return;
    }
    setSending(true);
    setError('');
    try {
      const data = new FormData();
      data.append('customer_id', String(customer.id));
      files.forEach((file) => data.append('files', file));
      if (subject.trim()) data.append('subject', subject.trim());
      if (message.trim()) data.append('message', message.trim());
      data.append('send_email', sendEmail ? 'true' : 'false');
      if (sendEmail && emailTo.trim()) data.append('email_to', emailTo.trim());
      if (sendEmail && emailCc.trim()) data.append('email_cc', emailCc.trim());
      const response = await authFetch('/api/file-transfers', { method: 'POST', body: data });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to send files');
      setNotice(noticeFor(body.email, configured));
      setFiles([]);
      setSubject('');
      setMessage('');
      setEmailCc('');
      setOffset(0);
      await loadTransfers(0, filterCustomer && filterCustomer.id);
    } catch (err) {
      setError(err.message || 'Unable to send files');
    } finally {
      setSending(false);
    }
  }

  return (
    <Box data-testid="send-files-page" sx={{ display: 'grid', gap: 2, minWidth: 0, maxWidth: 980 }}>
      <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, overflow: 'hidden' }}>
        <Box sx={{ bgcolor: brand.navy, color: '#fff', px: 2, py: 1.25, borderBottom: `4px solid ${brand.orange}` }}>
          <Typography sx={{ fontWeight: 800 }}>Send files</Typography>
          <Typography variant="body2" sx={{ opacity: 0.9 }}>
            Send files straight to a customer. No order is required.
          </Typography>
        </Box>
        <Box component="form" onSubmit={sendFiles} sx={{ p: { xs: 1.5, sm: 2 }, display: 'grid', gap: 2 }}>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {notice ? <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert> : null}
          {mail && !mail.configured ? (
            <Alert severity="warning">Email isn't set up. Files are still shared in Ignition.</Alert>
          ) : null}
          {mail && mail.configured && mail.public_url_set === false ? (
            <Alert severity="info">The public app address is not set, so the email link may not open Ignition.</Alert>
          ) : null}
          <Autocomplete
            options={customers}
            value={customer}
            onChange={chooseCustomer}
            getOptionLabel={customerLabel}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            renderOption={(props, option) => (
              <li {...props} key={option.id}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 700 }}>{customerLabel(option)}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                    {[option.company, option.email].filter(Boolean).join(' · ') || option.username}
                  </Typography>
                </Box>
              </li>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Customer"
                required
                placeholder="Search customers"
                inputProps={{ ...params.inputProps, 'data-testid': 'send-files-customer' }}
              />
            )}
          />
          <TextField
            label="Subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            inputProps={{ 'data-testid': 'send-files-subject', maxLength: 180 }}
            helperText="Optional. Shown to the customer and used as the email subject."
          />
          <TextField
            label="Message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            multiline
            minRows={2}
            inputProps={{ 'data-testid': 'send-files-message' }}
            placeholder="Optional note for the customer"
          />
          <Button component="label" variant="outlined" sx={{ justifySelf: 'start', borderColor: brand.navy, color: brand.navy, maxWidth: '100%' }}>
            Choose files
            <input
              hidden
              type="file"
              multiple
              data-testid="send-files-input"
              onChange={(event) => setFiles(Array.from(event.target.files || []))}
            />
          </Button>
          <Typography variant="body2" color="text.secondary" data-testid="send-files-names" sx={{ overflowWrap: 'anywhere' }}>
            {fileNames || 'No files selected'}
          </Typography>
          <FormControlLabel
            control={(
              <Checkbox
                checked={sendEmail}
                disabled={!configured}
                onChange={(event) => setSendEmail(event.target.checked)}
              />
            )}
            label="Email the customer"
          />
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            <TextField
              label="To"
              value={emailTo}
              onChange={(event) => setEmailTo(event.target.value)}
              disabled={!sendEmail}
              inputProps={{ 'data-testid': 'send-files-to' }}
              helperText="Defaults to the customer email."
            />
            <TextField
              label="CC"
              value={emailCc}
              onChange={(event) => setEmailCc(event.target.value)}
              disabled={!sendEmail}
              inputProps={{ 'data-testid': 'send-files-cc' }}
              helperText="Optional. Separate addresses with commas."
            />
          </Box>
          <Button
            type="submit"
            variant="contained"
            color="secondary"
            disabled={sending}
            data-testid="send-files-submit"
            sx={{ justifySelf: { xs: 'stretch', sm: 'start' }, fontWeight: 800 }}
          >
            {sending ? 'Sending...' : 'Send files'}
          </Button>
        </Box>
      </Box>

      <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, overflow: 'hidden' }}>
        <Box sx={{ bgcolor: brand.navy, color: '#fff', px: 2, py: 1.25, borderBottom: `4px solid ${brand.orange}`, display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography sx={{ fontWeight: 800 }}>Sent files</Typography>
        </Box>
        <Box sx={{ p: { xs: 1.5, sm: 2 }, display: 'grid', gap: 1.5 }}>
          <Autocomplete
            options={customers}
            value={filterCustomer}
            onChange={(_, value) => {
              setOffset(0);
              setFilterCustomer(value);
            }}
            getOptionLabel={customerLabel}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Filter by customer"
                placeholder="All customers"
                inputProps={{ ...params.inputProps, 'data-testid': 'sent-files-filter' }}
              />
            )}
          />
          {loading ? <Typography color="text.secondary">Loading sent files...</Typography> : null}
          {!loading ? (
            <FileTransferList
              transfers={transfers}
              timeZone={payload?.timezone}
              canManage
              onChanged={() => loadTransfers(offset, filterCustomer && filterCustomer.id)}
              emptyText="No files sent yet."
            />
          ) : null}
          <Pager
            offset={offset}
            limit={limit}
            total={payload?.total || 0}
            onChange={(next) => setOffset(next)}
          />
        </Box>
      </Box>
    </Box>
  );
}
