import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Link, Typography } from '@mui/material';
import { DivisionCredit } from '../components/AcgMark';
import BrandLogo from '../components/BrandLogo';
import SmsOptInForm from '../components/SmsOptInForm';
import { brand } from '../brand';
import {
  COMPANY_CONTACT,
  PRIVACY_SHARING,
  PRIVACY_TRANSACTIONAL,
  SMS_CONSENT,
  SMS_DISCLOSURE,
  SMS_PREVIEW_LABEL,
} from '../smsConsent';
import { useDocumentTitle } from '../useDocumentTitle';

const bodySx = {
  fontSize: { xs: '1.2rem', sm: '1.3rem' },
  lineHeight: 1.55,
  color: brand.text,
  mb: 2,
};

const headingSx = {
  color: brand.navy,
  fontWeight: 800,
  fontSize: { xs: '1.45rem', sm: '1.7rem' },
  lineHeight: 1.3,
  mt: 3,
  mb: 1,
};

function PublicLink({ to, children }) {
  return (
    <Link
      component={RouterLink}
      to={to}
      sx={{
        color: '#fff',
        fontWeight: 800,
        fontSize: { xs: '1.05rem', sm: '1.2rem' },
        textDecoration: 'underline',
        textUnderlineOffset: '3px',
        '&:hover': { color: brand.orange },
      }}
    >
      {children}
    </Link>
  );
}

function PublicShell({ title, children }) {
  useDocumentTitle(title);
  return (
    <Box sx={{ minHeight: '100vh', bgcolor: brand.page, color: brand.text, display: 'flex', flexDirection: 'column' }}>
      <Box component="header" sx={{ bgcolor: brand.navy, color: '#fff', px: { xs: 2, sm: 4 }, py: { xs: 2, sm: 3 } }}>
        <Box sx={{ maxWidth: 920, mx: 'auto' }}>
          <Box sx={{ bgcolor: '#fff', borderRadius: 1.5, px: 1.25, py: 1, width: 'fit-content', maxWidth: '100%' }}>
            <BrandLogo sx={{ width: { xs: 190, sm: 240 } }} />
          </Box>
          <Typography component="h1" sx={{ mt: 2, fontWeight: 800, fontSize: { xs: '2rem', sm: '2.5rem' }, lineHeight: 1.15 }}>
            {title}
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: { xs: 1.5, sm: 2.5 }, mt: 1.5 }}>
            <PublicLink to="/sms-opt-in">Text opt-in</PublicLink>
            <PublicLink to="/terms">Terms of Service</PublicLink>
            <PublicLink to="/privacy">Privacy Policy</PublicLink>
            <PublicLink to="/login">Sign in</PublicLink>
          </Box>
        </Box>
      </Box>
      <Box component="main" sx={{ maxWidth: 920, mx: 'auto', width: '100%', px: { xs: 2, sm: 4 }, py: { xs: 3, sm: 4 }, flex: 1 }}>
        {children}
      </Box>
      <Box component="footer" sx={{ px: { xs: 2, sm: 4 }, pb: 3 }}>
        <DivisionCredit height={36} sx={{ mx: 'auto' }} />
      </Box>
    </Box>
  );
}

function Prose({ children }) {
  return (
    <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderTop: `4px solid ${brand.orange}`, borderRadius: 2, p: { xs: 2.5, sm: 4 } }}>
      {children}
    </Box>
  );
}

export function TermsPage() {
  return (
    <PublicShell title="Terms of Service">
      <Prose>
        <Typography sx={bodySx}>
          Accent Corporate Graphics is a division of Accent Imaging, Inc. These terms cover Launchpad and the optional order-status text messages a customer can turn on inside a Launchpad account.
        </Typography>
        <Typography component="h2" sx={{ ...headingSx, mt: 0 }}>
          Order status texts
        </Typography>
        <Typography sx={bodySx}>
          {SMS_CONSENT}
          {' '}
          {SMS_DISCLOSURE}
        </Typography>
        <Typography sx={bodySx}>
          {PRIVACY_TRANSACTIONAL}
          {' '}
          A text may tell you when an order is ready for pickup. Message frequency is about 1 message per order. Message and data rates may apply. Reply HELP for help or STOP to cancel at any time. Consent is not required to make a purchase.
        </Typography>
        <Typography component="h2" sx={headingSx}>
          Using Launchpad
        </Typography>
        <Typography sx={bodySx}>
          Place orders only for work you are authorized to request. Keep your password to yourself. Information you enter on an order is used to produce and deliver that job. Turning texts on or off does not change whether Accent Imaging can accept an order.
        </Typography>
        <Typography component="h2" sx={headingSx}>
          Contact
        </Typography>
        <Typography sx={{ ...bodySx, mb: 0 }}>
          Contact
          {' '}
          {COMPANY_CONTACT}
          . You can also read the
          {' '}
          <Link component={RouterLink} to="/privacy" sx={{ color: brand.navy, fontWeight: 800 }}>Privacy Policy</Link>
          {' '}
          and see
          {' '}
          <Link component={RouterLink} to="/sms-opt-in" sx={{ color: brand.navy, fontWeight: 800 }}>how customers opt in</Link>
          .
        </Typography>
      </Prose>
    </PublicShell>
  );
}

export function PrivacyPage() {
  return (
    <PublicShell title="Privacy Policy">
      <Prose>
        <Typography sx={bodySx}>
          Accent Corporate Graphics, a division of Accent Imaging, Inc., uses Launchpad to take orders and to tell customers about those orders.
        </Typography>
        <Typography component="h2" sx={{ ...headingSx, mt: 0 }}>
          Mobile numbers and text messages
        </Typography>
        <Typography sx={bodySx}>
          {PRIVACY_TRANSACTIONAL}
          {' '}
          They are messages about an order you placed, such as when that order is ready for pickup. They are not marketing messages.
        </Typography>
        <Typography sx={bodySx} data-testid="privacy-sharing">
          {PRIVACY_SHARING}
        </Typography>
        <Typography sx={bodySx}>
          If you add a mobile number and check the consent box in your Launchpad account, we store that number and that consent so we can send those order notifications. You can turn texts off in your account, or reply STOP to a message. Consent is not required to make a purchase.
        </Typography>
        <Typography component="h2" sx={headingSx}>
          Other order details
        </Typography>
        <Typography sx={bodySx}>
          Launchpad stores the company, contact, address, and job details you submit so Accent Imaging can produce the order, share proofs and files with you, and show you the status of your own work. Staff see the orders they are allowed to work on. Another customer cannot open your orders.
        </Typography>
        <Typography component="h2" sx={headingSx}>
          Contact
        </Typography>
        <Typography sx={{ ...bodySx, mb: 0 }} data-testid="privacy-contact">
          Contact
          {' '}
          {COMPANY_CONTACT}
          . Questions about these texts can also go to that address. See the
          {' '}
          <Link component={RouterLink} to="/terms" sx={{ color: brand.navy, fontWeight: 800 }}>Terms of Service</Link>
          {' '}
          and
          {' '}
          <Link component={RouterLink} to="/sms-opt-in" sx={{ color: brand.navy, fontWeight: 800 }}>how customers opt in</Link>
          .
        </Typography>
      </Prose>
    </PublicShell>
  );
}

export function SmsOptInPage() {
  return (
    <PublicShell title="Text message opt-in">
      <Box
        data-testid="sms-opt-in-preview-note"
        sx={{
          bgcolor: '#FFF6E8',
          border: `2px solid ${brand.orange}`,
          borderRadius: 2,
          p: { xs: 2, sm: 2.5 },
          mb: 2,
        }}
      >
        <Typography sx={{ fontWeight: 800, fontSize: { xs: '1.3rem', sm: '1.5rem' }, color: brand.navy, lineHeight: 1.35 }}>
          {SMS_PREVIEW_LABEL}
        </Typography>
        <Typography sx={{ mt: 1, fontSize: '1.2rem', lineHeight: 1.5 }}>
          This page is a preview of the form on Place an order. It does not create an account, save a mobile number, or turn texts on.
        </Typography>
      </Box>
      <SmsOptInForm preview />
    </PublicShell>
  );
}
