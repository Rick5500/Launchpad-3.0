import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, MenuItem, TextField, Typography } from '@mui/material';
import { authFetch } from '../api';
import { brand } from '../brand';
import { ORDER_STATUS_OPEN, ORDER_STATUS_READY } from '../smsConsent';

const fieldSx = {
  '& .MuiInputBase-input': { fontSize: '1.2rem', fontWeight: 700 },
  '& .MuiInputLabel-root': { fontSize: '1.05rem' },
};

function noticeLine(kind, status, sentAt) {
  if (!status) return null;
  const when = sentAt ? ` ${sentAt}` : '';
  if (kind === 'email') {
    if (status === 'sent') return `Email sent${when}.`;
    if (status === 'not_configured') return 'Email is not set up. The order status was still saved.';
    if (status === 'failed') return 'Email could not be sent. The order status was still saved.';
    if (status === 'skipped') return 'No email address on this order.';
    return null;
  }
  if (status === 'sent') return `Text sent${when}.`;
  if (status === 'dry_run') return `Text logged${when}. Twilio is not configured, so it was not sent.`;
  if (status === 'skipped') return 'No text. The customer has not opted in.';
  if (status === 'invalid') return 'No text. The mobile number is not valid.';
  if (status === 'failed') return 'Text could not be sent. The order status was still saved.';
  return null;
}

export default function PickupStatusControl({
  orderId,
  status,
  emailStatus,
  emailSentAt,
  smsStatus,
  smsSentAt,
  onUpdated,
}) {
  const [value, setValue] = useState(status || ORDER_STATUS_OPEN);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setValue(status || ORDER_STATUS_OPEN);
  }, [status]);

  async function save() {
    if (!orderId) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await authFetch(`/api/orders/${orderId}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: value }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to update the order status');
      const order = body.order || {};
      const pickup = body.pickup_notice;
      if (pickup && pickup.reason === 'already_notified') {
        setNotice('Already ready for pickup. Nothing was sent again.');
      } else if (pickup && (pickup.email || pickup.sms)) {
        const lines = [
          noticeLine('email', pickup.email && pickup.email.status, pickup.email && pickup.email.sent_at),
          noticeLine('sms', pickup.sms && pickup.sms.status, pickup.sms && pickup.sms.sent_at),
        ].filter(Boolean);
        setNotice(lines.join(' '));
      } else if (value === ORDER_STATUS_READY) {
        setNotice('Marked ready for pickup.');
      } else {
        setNotice('Order status saved.');
      }
      if (onUpdated) onUpdated(order, body);
    } catch (err) {
      setError(err.message || 'Unable to update the order status');
    } finally {
      setSaving(false);
    }
  }

  const savedEmail = noticeLine('email', emailStatus, emailSentAt);
  const savedSms = noticeLine('sms', smsStatus, smsSentAt);

  return (
    <Box
      data-testid="pickup-status"
      sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderLeft: `6px solid ${brand.orange}`, borderRadius: 1.5, p: 2 }}
    >
      <Typography sx={{ color: brand.navy, fontWeight: 800, fontSize: '1.35rem', mb: 0.5 }}>
        Pickup status
      </Typography>
      <Typography sx={{ color: brand.muted, fontSize: '1.05rem', mb: 1.5 }}>
        Mark the order Ready for Pickup to email the customer and text them when they have opted in. Saving the same status again does not send another message.
      </Typography>
      {error ? <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" sx={{ mb: 1.5 }}>{notice}</Alert> : null}
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          select
          label="Order status"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          sx={{ minWidth: 260, ...fieldSx }}
          SelectProps={{ inputProps: { 'data-testid': 'pickup-status-select' } }}
        >
          <MenuItem value={ORDER_STATUS_OPEN}>{ORDER_STATUS_OPEN}</MenuItem>
          <MenuItem value={ORDER_STATUS_READY}>{ORDER_STATUS_READY}</MenuItem>
        </TextField>
        <Button
          variant="contained"
          disabled={saving}
          onClick={save}
          data-testid="pickup-status-save"
          sx={{ bgcolor: brand.orange, color: '#111', fontWeight: 800, fontSize: '1.05rem', px: 2.5, py: 1.2 }}
        >
          {saving ? 'Saving...' : 'Save status'}
        </Button>
      </Box>
      {(savedEmail || savedSms) ? (
        <Typography sx={{ mt: 1.5, color: brand.muted, fontSize: '1rem' }}>
          {[savedEmail, savedSms].filter(Boolean).join(' ')}
        </Typography>
      ) : null}
    </Box>
  );
}
