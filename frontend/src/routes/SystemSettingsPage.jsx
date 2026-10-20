import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TextField,
  FormControlLabel,
  Switch,
  Typography,
} from '@mui/material';
import SectionCard from '../components/SectionCard';
import LoadingState from '../components/LoadingState';
import { authFetch } from '../api';

export default function SystemSettingsPage() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({
    company_name: '',
    company_address: '',
    company_phone: '',
    due_soon_hours: '',
    last_backup_at: '',
    customer_self_signup_enabled: true,
    email_customers_on_file_share: true,
    email_customers_on_proof: true,
    inbound_email_polling_enabled: true,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [checkingMail, setCheckingMail] = useState(false);

  function apply(body) {
    setSettings(body);
    setForm({
      company_name: body.letterhead?.company_name || '',
      company_address: body.letterhead?.company_address || '',
      company_phone: body.letterhead?.company_phone || '',
      due_soon_hours: body.due_soon_hours?.value == null ? '' : String(body.due_soon_hours.value),
      last_backup_at: body.last_backup_at || '',
      customer_self_signup_enabled: body.customer_self_signup_enabled !== false,
      email_customers_on_file_share: body.email_customers_on_file_share !== false,
      email_customers_on_proof: body.email_customers_on_proof !== false,
      inbound_email_polling_enabled: body.inbound_email_polling_enabled !== false,
    });
  }

  useEffect(() => {
    authFetch('/api/settings')
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load settings');
        apply(body);
      })
      .catch((err) => setError(err.message || 'Unable to load settings'))
      .finally(() => setLoading(false));
  }, []);

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await authFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          company_name: form.company_name,
          company_address: form.company_address,
          company_phone: form.company_phone,
          due_soon_hours: form.due_soon_hours === '' ? null : Number(form.due_soon_hours),
          last_backup_at: form.last_backup_at.trim() === '' ? null : form.last_backup_at.trim(),
          customer_self_signup_enabled: form.customer_self_signup_enabled,
          email_customers_on_file_share: form.email_customers_on_file_share,
          email_customers_on_proof: form.email_customers_on_proof,
          inbound_email_polling_enabled: form.inbound_email_polling_enabled,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to save settings');
      apply(body);
      setNotice('Settings saved.');
    } catch (err) {
      setError(err.message || 'Unable to save settings');
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setError('');
    setNotice('');
    try {
      const response = await authFetch('/api/settings/test-email', {
        method: 'POST',
        body: JSON.stringify({ to: testTo.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to send test email');
      setNotice(`Test email sent to ${body.to}.`);
    } catch (err) {
      setError(err.message || 'Unable to send test email');
    } finally {
      setTesting(false);
    }
  }

  async function checkMailbox() {
    setCheckingMail(true);
    setError('');
    setNotice('');
    try {
      const response = await authFetch('/api/inbound-emails/sync', { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to check the mailbox');
      const refreshed = await authFetch('/api/settings');
      const next = await refreshed.json().catch(() => ({}));
      if (refreshed.ok) apply(next);
      setNotice(body.imported ? `Checked the mailbox. ${body.imported} new email${body.imported === 1 ? '' : 's'}.` : 'Checked the mailbox. No new email.');
    } catch (err) {
      setError(err.message || 'Unable to check the mailbox');
      const refreshed = await authFetch('/api/settings').catch(() => null);
      if (refreshed && refreshed.ok) {
        const next = await refreshed.json().catch(() => ({}));
        apply(next);
      }
    } finally {
      setCheckingMail(false);
    }
  }

  const readOnly = settings?.read_only || {};
  const inbound = settings?.inbound_mail || {};
  const rows = [
    ['Delivery timezone', readOnly.delivery_timezone],
    ['Will Call hours', readOnly.will_call_window_start ? `${readOnly.will_call_window_start} – ${readOnly.will_call_window_end}` : ''],
    ['Delivery hours', readOnly.delivery_window_start ? `${readOnly.delivery_window_start} – ${readOnly.delivery_window_end}` : ''],
    ['Will-call cutoff', readOnly.will_call_cutoff],
    ['Carrier cutoff', readOnly.carrier_cutoff],
    ['Slot minutes', readOnly.delivery_slot_minutes],
    ['Max upload size', readOnly.max_upload_mb != null ? `${readOnly.max_upload_mb} MB` : ''],
    ['Max files per request', readOnly.max_upload_files],
    ['Max unattached uploads', readOnly.max_unattached_uploads],
    ['Unattached file retention', readOnly.upload_orphan_hours != null ? `${readOnly.upload_orphan_hours} hours` : ''],
    ['Email', settings?.mail?.configured ? `Configured${settings.mail.from ? ` · ${settings.mail.from}` : ''}` : 'Not set up'],
  ];

  return (
    <Box data-testid="settings-page">
      <Typography variant="h4" gutterBottom>System Settings</Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Letterhead is used by the printable work order. Pickup hours, delivery hours, cutoffs, timezone, and upload limits come from the server environment and are read-only here.
      </Typography>
      {loading ? <LoadingState message="Loading settings..." /> : null}
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert> : null}

      <SectionCard title="Company letterhead" subtitle="Defaults match Accent Imaging, Inc., 8121 Brownleigh Drive, Raleigh, NC 27617, 919-782-3332.">
        <Box component="form" onSubmit={save} sx={{ display: 'grid', gap: 2, maxWidth: 640 }}>
          <TextField label="Company name" value={form.company_name} onChange={(event) => setForm({ ...form, company_name: event.target.value })} required />
          <TextField label="Address" value={form.company_address} onChange={(event) => setForm({ ...form, company_address: event.target.value })} required multiline minRows={3} />
          <TextField label="Phone" value={form.company_phone} onChange={(event) => setForm({ ...form, company_phone: event.target.value })} required />
          <TextField
            label="Due-soon hours"
            type="number"
            value={form.due_soon_hours}
            onChange={(event) => setForm({ ...form, due_soon_hours: event.target.value })}
            helperText={settings?.due_soon_hours
              ? `Environment value is ${settings.due_soon_hours.environment_value}. Current source: ${settings.due_soon_hours.source}. Clear and save to follow the environment again.`
              : 'Hours before a due time that count as due soon.'}
          />
          <TextField
            label="Last backup"
            value={form.last_backup_at}
            onChange={(event) => setForm({ ...form, last_backup_at: event.target.value })}
            placeholder="YYYY-MM-DD HH:MM:SS"
            helperText="Leave blank if no backup has been recorded. The Dashboard shows this timestamp."
          />
          <FormControlLabel
            control={(
              <Switch
                checked={form.customer_self_signup_enabled}
                onChange={(event) => setForm({ ...form, customer_self_signup_enabled: event.target.checked })}
              />
            )}
            label="Allow customers to create an account"
          />
          <Typography variant="body2" color="text.secondary">
            When this is off, Create an account is hidden on the sign-in page. Existing customers can still sign in.
          </Typography>
          <FormControlLabel
            control={(
              <Switch
                checked={form.email_customers_on_file_share}
                onChange={(event) => setForm({ ...form, email_customers_on_file_share: event.target.checked })}
              />
            )}
            label="Email customers when files are shared"
          />
          <Typography variant="body2" color="text.secondary">
            This is the default on Send files. Staff can change it for one send. If email is not set up, the files are still shared in Launchpad.
          </Typography>
          <FormControlLabel
            control={(
              <Switch
                checked={form.email_customers_on_proof}
                onChange={(event) => setForm({ ...form, email_customers_on_proof: event.target.checked })}
              />
            )}
            label="Email customers when a proof is sent"
          />
          <Typography variant="body2" color="text.secondary">
            This is the default on Send Proof. The message links to sign in. It does not include a public download.
          </Typography>
          <FormControlLabel
            control={(
              <Switch
                checked={form.inbound_email_polling_enabled}
                onChange={(event) => setForm({ ...form, inbound_email_polling_enabled: event.target.checked })}
              />
            )}
            label="Poll the orders mailbox"
          />
          <Typography variant="body2" color="text.secondary">
            When this is off, Launchpad does not check Microsoft 365 on a schedule. Check now still reads the mailbox. Mail is never marked read, moved, or deleted.
          </Typography>
          <Box>
            <Button type="submit" variant="contained" disabled={saving || loading}>{saving ? 'Saving...' : 'Save settings'}</Button>
          </Box>
        </Box>
      </SectionCard>

      <SectionCard
        title="Email orders"
        subtitle={inbound.configured
          ? `${inbound.mailbox || 'Orders mailbox'} · ${inbound.folder || 'Inbox'} · every ${inbound.poll_seconds || 180} seconds`
          : 'Microsoft 365 is not configured. Set M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET, and M365_MAILBOX on the server. Those values are not stored here.'}
      >
        <Typography sx={{ mb: 1 }}>
          {inbound.last_success_at ? `Last successful check: ${inbound.last_success_at}` : 'No successful check yet.'}
        </Typography>
        {inbound.last_status === 'error' && inbound.last_error ? (
          <Alert severity="warning" sx={{ mb: 1 }}>{inbound.last_error}</Alert>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {inbound.last_status === 'ok' ? 'The last check succeeded.' : 'Status appears after the first check.'}
          </Typography>
        )}
        <Button variant="outlined" disabled={checkingMail || !inbound.configured} onClick={checkMailbox}>
          {checkingMail ? 'Checking…' : 'Check now'}
        </Button>
      </SectionCard>

      <SectionCard title="Test email" subtitle="Sends a short message with the letterhead above. Files shared with a customer use the same mail setup.">
        {settings?.mail?.configured ? null : (
          <Alert severity="warning" sx={{ mb: 2 }}>Email isn't set up.</Alert>
        )}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <TextField
            label="Send a test to"
            value={testTo}
            onChange={(event) => setTestTo(event.target.value)}
            sx={{ minWidth: 280 }}
          />
          <Button variant="outlined" onClick={sendTest} disabled={testing || loading} data-testid="send-test-email">
            {testing ? 'Sending...' : 'Send test email'}
          </Button>
        </Box>
      </SectionCard>

      <SectionCard title="Environment" subtitle="These values are read from the server environment. Restart the server after changing them.">
        <Table size="small">
          <TableBody>
            {rows.map(([label, value]) => (
              <TableRow key={label}>
                <TableCell sx={{ fontWeight: 600, width: '40%' }}>{label}</TableCell>
                <TableCell>{value == null || value === '' ? '—' : String(value)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {readOnly.delivery_timezone_configured == null ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            DELIVERY_TIMEZONE is not set, so the code default is in use.
          </Typography>
        ) : null}
      </SectionCard>
    </Box>
  );
}
