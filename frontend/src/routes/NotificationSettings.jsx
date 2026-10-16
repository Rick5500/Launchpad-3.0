import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  FormControlLabel,
  Switch,
  Typography,
} from '@mui/material';
import SectionCard from '../components/SectionCard';
import { authFetch } from '../api';

export default function NotificationSettings() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function load() {
    authFetch('/api/notifications/settings')
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load notification settings');
        setSettings(body);
      })
      .catch((err) => setError(err.message || 'Unable to load notification settings'));
  }

  useEffect(() => {
    load();
  }, []);

  async function toggle(eventKey, enabled) {
    setError('');
    setNotice('');
    const response = await authFetch('/api/notifications/settings', {
      method: 'PUT',
      body: JSON.stringify({ events: { [eventKey]: enabled } }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error || 'Unable to update notification settings');
      return;
    }
    setSettings(body);
    setNotice('Notification settings saved.');
  }

  if (!settings && !error) return null;

  return (
    <Box data-testid="notification-settings" sx={{ mb: 2 }}>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert> : null}
      <SectionCard title="In-app events" subtitle="Turn events on or off. Existing notifications stay in the list.">
        {(settings?.in_app || []).map((event) => (
          <FormControlLabel
            key={event.event_key}
            sx={{ display: 'flex', ml: 0 }}
            control={<Switch checked={Boolean(event.enabled)} onChange={(change) => toggle(event.event_key, change.target.checked)} />}
            label={`${event.label} — ${event.description}`}
          />
        ))}
      </SectionCard>
      <SectionCard title="Email" subtitle={settings?.email_label || 'Email delivery is off. No mail is sent.'}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Email stubs stay off. There is no mail server, and these switches cannot be enabled.
        </Typography>
        {(settings?.email || []).map((event) => (
          <FormControlLabel
            key={event.event_key}
            sx={{ display: 'flex', ml: 0 }}
            control={<Switch checked={false} disabled />}
            label={`${event.label} — ${event.description}`}
          />
        ))}
      </SectionCard>
    </Box>
  );
}
