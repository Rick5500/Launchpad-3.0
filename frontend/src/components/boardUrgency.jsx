import React from 'react';
import { Box, Chip, Typography } from '@mui/material';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import ScheduleIcon from '@mui/icons-material/Schedule';
import TodayIcon from '@mui/icons-material/Today';
import BoltIcon from '@mui/icons-material/Bolt';
import FiberNewIcon from '@mui/icons-material/FiberNew';
import { brand } from '../brand';

// Row fills follow the Launch Pad 2.0 order monitor: a red-orange-yellow wash
// for overdue, a lighter yellow for due today or due soon, pale yellow for a
// job that has not been retrieved, and white / pale lavender otherwise.
// The word and icon stay so colour is not the only signal.
export const URGENCY_STYLES = {
  overdue: {
    label: 'Overdue',
    bgcolor: '#ff7a1a',
    background: 'linear-gradient(90deg, #ff5e54 0%, #ff7a1a 34%, #ffc14d 70%, #ffe98a 100%)',
    border: '#C62828',
    chipBg: '#F8D0D0',
    chipColor: '#7F1D1D',
    Icon: ErrorOutlineIcon,
  },
  due_soon: {
    label: 'Due soon',
    bgcolor: '#fff4b0',
    background: '#fff4b0',
    border: '#C2410C',
    chipBg: '#FDE0C4',
    chipColor: '#7C2D12',
    Icon: ScheduleIcon,
  },
  due_today: {
    label: 'Due today',
    bgcolor: '#fff4b0',
    background: '#fff4b0',
    border: '#B8860B',
    chipBg: '#FDE9A8',
    chipColor: '#6B4E00',
    Icon: TodayIcon,
  },
  rush: {
    label: 'Rush',
    bgcolor: '#ffffff',
    background: '#ffffff',
    border: brand.navy,
    chipBg: brand.orange,
    chipColor: '#1B2838',
    Icon: BoltIcon,
  },
  fresh: {
    label: 'New',
    bgcolor: '#fff8d2',
    background: '#fff8d2',
    border: '#E6C200',
    chipBg: '#fff3b0',
    chipColor: '#6B4E00',
    Icon: FiberNewIcon,
  },
};

const SIGNAL_TONE = {
  Overdue: 'overdue',
  'Due soon': 'due_soon',
  'Due today': 'due_today',
  Rush: 'rush',
  New: 'fresh',
};

const LAVENDER = '#eceaf8';

export function urgencyTone(urgency) {
  return urgency && urgency.tone ? URGENCY_STYLES[urgency.tone] : null;
}

export function rowSurface(row, index) {
  const tone = row?.urgency?.tone;
  const fresh = !row?.retrieved_at;
  if (tone === 'overdue') {
    return { background: URGENCY_STYLES.overdue.background, bold: fresh };
  }
  if (tone === 'due_today' || tone === 'due_soon') {
    return { background: URGENCY_STYLES.due_today.background, bold: fresh };
  }
  if (fresh) return { background: URGENCY_STYLES.fresh.background, bold: true };
  return { background: index % 2 === 0 ? '#ffffff' : LAVENDER, bold: false };
}

function chipSx(style) {
  return {
    bgcolor: style.chipBg,
    color: style.chipColor,
    fontWeight: 800,
    height: 20,
    fontSize: 11,
    '& .MuiChip-icon': { color: style.chipColor, fontSize: 14, ml: 0.4 },
    '& .MuiChip-label': { px: 0.6 },
  };
}

export function UrgencyChips({ urgency, fresh = false }) {
  const signals = [...(urgency?.signals || [])];
  if (fresh && !signals.includes('New')) signals.push('New');
  if (!signals.length) return null;
  return (
    <>
      {signals.map((signal) => {
        const style = URGENCY_STYLES[SIGNAL_TONE[signal]];
        if (!style) return null;
        const Icon = style.Icon;
        return (
          <Chip
            key={signal}
            size="small"
            icon={<Icon />}
            label={signal}
            sx={chipSx(style)}
          />
        );
      })}
    </>
  );
}

function Swatch({ background, label, bold = false }) {
  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        background,
        border: '1px solid rgba(27,40,56,0.12)',
        borderRadius: 0.5,
        px: 1,
        py: 0.3,
      }}
    >
      <Typography sx={{ fontSize: 12, fontWeight: bold ? 800 : 700, color: '#1B2838' }}>{label}</Typography>
    </Box>
  );
}

export function UrgencyLegend({ timezone }) {
  return (
    <Box data-testid="urgency-legend" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
      <Swatch background={URGENCY_STYLES.overdue.background} label="Overdue" bold />
      <Swatch background={URGENCY_STYLES.due_today.background} label="Due today / soon" />
      <Swatch background={URGENCY_STYLES.fresh.background} label="New (not retrieved)" bold />
      <Swatch background="#ffffff" label="In production" />
      <Swatch background={LAVENDER} label="In production" />
      <Chip size="small" icon={<BoltIcon />} label="Rush" sx={chipSx(URGENCY_STYLES.rush)} />
      <Typography sx={{ fontSize: 12, color: brand.muted, flexBasis: { xs: '100%', lg: 'auto' } }}>
        Shop time{timezone ? ` (${timezone})` : ''}. A job can be Rush and overdue at the same time. On hold and completed jobs are not marked overdue. New jobs are bold until they are retrieved.
      </Typography>
    </Box>
  );
}

function clockLabel(hour, minute, second) {
  const suffix = hour >= 12 ? 'pm' : 'am';
  const shown = hour % 12 || 12;
  const seconds = second != null ? `:${String(second).padStart(2, '0')}` : '';
  return `${shown}:${String(minute).padStart(2, '0')}${seconds} ${suffix}`;
}

export function splitWall(value, { seconds = false } = {}) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(value || '').trim());
  if (!match) return { date: '', time: '' };
  const date = `${Number(match[2])}/${Number(match[3])}/${match[1]}`;
  if (!match[4]) return { date, time: '' };
  return {
    date,
    time: clockLabel(Number(match[4]), match[5], seconds && match[6] != null ? match[6] : null),
  };
}

export function splitInstant(value, timeZone, { seconds = false } = {}) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value || '').trim());
  if (!match) return { date: '', time: '' };
  const utc = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0)
  ));
  if (!timeZone || Number.isNaN(utc.valueOf())) return splitWall(value, { seconds });
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: seconds ? '2-digit' : undefined,
      hourCycle: 'h23',
    }).formatToParts(utc).map((part) => [part.type, part.value]));
    const hour = Number(parts.hour) % 24;
    return {
      date: `${Number(parts.month)}/${Number(parts.day)}/${parts.year}`,
      time: clockLabel(hour, parts.minute, seconds ? parts.second : null),
    };
  } catch (err) {
    return splitWall(value, { seconds });
  }
}
