import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Box, Button, Checkbox, FormControlLabel, Link, TextField, Typography } from '@mui/material';
import { brand } from '../brand';
import { SMS_CONSENT, SMS_DISCLOSURE, SMS_SAVE_LABEL } from '../smsConsent';

const fieldSx = {
  '& .MuiInputBase-input': { fontSize: '1.25rem' },
  '& .MuiInputLabel-root': { fontSize: '1.15rem' },
};

function LegalLinks({ newTab }) {
  const extra = newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {};
  const linkSx = {
    color: brand.navy,
    fontWeight: 800,
    fontSize: '1.2rem',
    textDecoration: 'underline',
    textUnderlineOffset: '3px',
  };
  return (
    <Typography sx={{ fontSize: '1.2rem', lineHeight: 1.5 }}>
      <Link component={RouterLink} to="/terms" sx={linkSx} {...extra}>Terms of Service</Link>
      {' and '}
      <Link component={RouterLink} to="/privacy" sx={linkSx} {...extra}>Privacy Policy</Link>
    </Typography>
  );
}

export default function SmsOptInForm({
  mobilePhone = '',
  onMobilePhoneChange,
  smsOptIn = false,
  onSmsOptInChange,
  onSave,
  saving = false,
  error = '',
  notice = '',
  pendingHint = '',
  preview = false,
}) {
  const checked = preview ? false : Boolean(smsOptIn);

  return (
    <Box
      data-testid={preview ? 'sms-opt-in-preview' : 'profile-texting'}
      sx={{
        bgcolor: '#fff',
        border: `1px solid ${brand.border}`,
        borderLeft: `6px solid ${brand.navy}`,
        borderRadius: 2,
        p: { xs: 2, sm: 2.5 },
      }}
    >
      <Typography sx={{ color: brand.navy, fontWeight: 800, fontSize: { xs: '1.45rem', sm: '1.7rem' }, lineHeight: 1.25 }}>
        Order status texts
      </Typography>
      <Typography sx={{ color: brand.muted, fontSize: '1.2rem', lineHeight: 1.45, mt: 0.75, mb: 1.5, maxWidth: 760 }}>
        Add a mobile number if you want a text when an order is ready for pickup. This stays off until you agree.
      </Typography>
      {error ? <Alert severity="error" sx={{ mb: 1.5, '& .MuiAlert-message': { fontSize: '1.1rem' } }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" sx={{ mb: 1.5, '& .MuiAlert-message': { fontSize: '1.1rem' } }}>{notice}</Alert> : null}
      <Box sx={{ display: 'grid', gap: 1.5, maxWidth: 720 }}>
        <TextField
          id={preview ? 'preview-mobile' : 'profile-mobile'}
          label="Mobile phone"
          value={preview ? '' : mobilePhone}
          onChange={(event) => {
            if (preview || !onMobilePhoneChange) return;
            onMobilePhoneChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (!preview && onSave) onSave(event);
          }}
          placeholder="919-555-0100"
          autoComplete={preview ? 'off' : 'tel'}
          inputProps={{
            readOnly: preview,
            'aria-readonly': preview || undefined,
            'data-testid': preview ? 'sms-opt-in-preview-mobile' : 'profile-mobile',
          }}
          sx={fieldSx}
        />
        <FormControlLabel
          sx={{
            alignItems: 'flex-start',
            m: 0,
            '& .MuiFormControlLabel-label': { fontSize: '1.25rem', lineHeight: 1.45, color: brand.text, fontWeight: 600 },
          }}
          control={(
            <Checkbox
              checked={checked}
              onChange={(event) => {
                if (preview || !onSmsOptInChange) return;
                onSmsOptInChange(event.target.checked);
              }}
              inputProps={{
                'data-testid': preview ? 'sms-opt-in-preview-checkbox' : 'sms-opt-in',
                'aria-label': SMS_CONSENT,
              }}
              sx={{ color: brand.navy, p: 0.75, mr: 1, '&.Mui-checked': { color: brand.orange } }}
            />
          )}
          label={SMS_CONSENT}
        />
        {!preview && pendingHint ? (
          <Typography data-testid="sms-opt-in-pending" sx={{ fontSize: '1.05rem', lineHeight: 1.45, color: brand.muted }}>
            {pendingHint}
          </Typography>
        ) : null}
        <Typography sx={{ fontSize: '1.15rem', lineHeight: 1.5, color: brand.text, maxWidth: 720 }}>
          {SMS_DISCLOSURE}
        </Typography>
        <LegalLinks newTab={!preview} />
        <Button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            if (preview || !onSave) return;
            onSave(event);
          }}
          variant="contained"
          disabled={!preview && saving}
          aria-disabled={preview || saving || undefined}
          data-testid={preview ? 'sms-opt-in-preview-save' : 'sms-save'}
          sx={{
            justifySelf: 'start',
            bgcolor: brand.navy,
            color: '#fff',
            fontWeight: 800,
            fontSize: '1.15rem',
            lineHeight: 1.3,
            px: 2.5,
            py: 1.25,
            textTransform: 'none',
            whiteSpace: 'normal',
            textAlign: 'left',
            '&:hover': { bgcolor: brand.navyDark },
          }}
        >
          {!preview && saving ? 'Saving...' : SMS_SAVE_LABEL}
        </Button>
      </Box>
    </Box>
  );
}
