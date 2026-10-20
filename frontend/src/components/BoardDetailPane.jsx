import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { authFetch } from '../api';
import { brand, formatShopStamp } from '../brand';
import { UrgencyChips } from './boardUrgency';
import ProofStatusChip from './ProofStatusChip';

function textOn(hex) {
  const value = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return '#fff';
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return (0.299 * red + 0.587 * green + 0.114 * blue) / 255 > 0.62 ? '#1B2838' : '#fff';
}

function historyStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'in-progress') return 'In Production';
  if (value === 'completed' || value === 'complete') return 'Complete';
  if (value === 'on-hold') return 'On Hold';
  if (value === 'open') return 'Open';
  if (value === 'submitted') return 'Submitted';
  return status || '—';
}

function boardStatusName(label, status) {
  const fromStatus = String(status || '').trim().toLowerCase();
  const fromLabel = String(label || '').trim().toLowerCase();
  if (fromStatus === 'in-progress' || fromLabel === 'in progress') return 'In Production';
  if (label) return label;
  return historyStatus(status);
}

function Fact({ label, value }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', color: brand.muted, textTransform: 'uppercase' }}>
        {label}
      </Typography>
      <Typography sx={{ fontSize: 14, color: brand.text, overflowWrap: 'anywhere' }}>
        {value || '—'}
      </Typography>
    </Box>
  );
}

function lineSummary(item) {
  const parts = [];
  if (item.quantity) parts.push(`Qty ${item.quantity}`);
  if (item.size) parts.push(item.size);
  if (item.media) parts.push(item.media);
  for (const field of item.fields || []) {
    const shown = field.display || field.value;
    if (shown) parts.push(`${field.label}: ${shown}`);
  }
  if (item.finishing) parts.push(`Finishing: ${item.finishing}`);
  return parts.join(' · ');
}

function instructionText(workOrder) {
  const own = String(workOrder?.notes || '').trim();
  const fromOrder = String(workOrder?.order_notes || '').trim();
  return own || fromOrder;
}

function formatHistoryTime(value, timeZone) {
  if (!value) return '—';
  return formatShopStamp(value, timeZone) || String(value).replace('T', ' ');
}

export default function BoardDetailPane({ row, refreshKey, timeZone, canMove, onClose, onMove }) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!row?.id) return undefined;
    let cancelled = false;
    setLoading(true);
    authFetch(`/api/workorders/${row.id}`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load this work order');
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setDetail(body);
        setError('');
      })
      .catch((err) => {
        if (cancelled) return;
        setDetail(null);
        setError(err.message || 'Unable to load this work order');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [row?.id, refreshKey]);

  if (!row) return null;

  const number = row.order_number || detail?.external_id || `WO-${row.id}`;
  const instructions = detail ? instructionText(detail) : '';
  const routing = String(detail?.routing_instructions || '').trim();
  const lines = detail?.line_items || [];
  const history = detail?.production_history || [];
  const activity = detail?.activity || [];

  return (
    <Box
      data-testid="board-detail"
      sx={{
        bgcolor: '#fff',
        border: `1px solid ${brand.border}`,
        borderTop: `4px solid ${brand.orange}`,
        borderRadius: 2,
        p: 2,
        minWidth: 0,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ color: brand.orange, fontWeight: 800, letterSpacing: '0.08em', fontSize: 11 }}>
            WORK ORDER
          </Typography>
          <Typography sx={{ color: brand.navy, fontWeight: 800, fontSize: 22, overflowWrap: 'anywhere', lineHeight: 1.15 }}>
            {number}
          </Typography>
          <Typography sx={{ color: brand.muted, fontSize: 14 }}>
            {row.company || detail?.customer_name || '—'}
          </Typography>
        </Box>
        <IconButton aria-label="Close work order details" onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </Box>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 1.25 }}>
        <UrgencyChips urgency={row.urgency} />
        {detail?.routing?.current_status_label && (
          <Chip
            label={boardStatusName(detail.routing.current_status_label, detail.routing.current_status)}
            size="small"
            sx={{ fontWeight: 700 }}
          />
        )}
        <ProofStatusChip status={detail?.proof_status} label={detail?.proof_status_label} testId="board-proof-status" />
        {row.department && (
          <Chip
            label={row.department}
            size="small"
            sx={{ fontWeight: 700, bgcolor: row.department_color || brand.navy, color: textOn(row.department_color || brand.navy) }}
          />
        )}
      </Box>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1.5 }}>
        <Button
          size="small"
          variant="outlined"
          onClick={() => navigate(`/work-orders/${row.id}/print`)}
          sx={{ textTransform: 'none', fontWeight: 700, borderColor: brand.navy, color: brand.navy }}
        >
          Print
        </Button>
        {canMove && (
          <Button
            size="small"
            variant="outlined"
            data-testid="detail-move"
            onClick={() => onMove(detail || row)}
            sx={{ textTransform: 'none', fontWeight: 700 }}
          >
            Move to…
          </Button>
        )}
        <Button
          size="small"
          variant="contained"
          onClick={() => navigate(`/work-orders/${row.id}/edit`)}
          sx={{ textTransform: 'none', fontWeight: 700, bgcolor: brand.orange, color: '#1B2838', '&:hover': { bgcolor: brand.orangeDark, color: '#fff' } }}
        >
          Edit
        </Button>
        <Button
          size="small"
          onClick={() => navigate(`/work-orders/${row.id}`)}
          sx={{ textTransform: 'none', fontWeight: 700, color: brand.navy }}
        >
          Open work order
        </Button>
      </Box>

      <Divider sx={{ my: 1.5 }} />

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.25 }}>
        <Fact label="Contact" value={row.contact_name} />
        <Fact label="Due" value={row.due_display} />
        <Fact label="Arrived" value={row.arrived_display} />
        <Fact label="Process" value={row.process} />
        <Fact label="Originals" value={row.originals_source_label} />
        <Fact label="Payment" value={row.payment_method_label} />
        <Fact label="Project" value={detail?.project_name} />
        <Fact label="Delivery" value={detail?.delivery_method} />
      </Box>

      {error && <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert>}
      {loading && !detail && (
        <Typography sx={{ mt: 1.5, color: brand.muted, fontSize: 14 }}>Loading lines and history…</Typography>
      )}

      {detail && (
        <Box sx={{ display: 'grid', gap: 1.5, mt: 1.75 }}>
          {(detail.proofs || []).some((proof) => proof.decided_at) ? (
            <Box data-testid="board-proof-comments">
              <Typography sx={{ color: brand.navy, fontWeight: 800, fontSize: 13, mb: 0.75 }}>PROOF COMMENTS</Typography>
              {detail.proofs.filter((proof) => proof.decided_at).map((proof) => (
                <Box key={`proof-${proof.id}`} sx={{ mb: 1, minWidth: 0 }}>
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

          <Box>
            <Typography sx={{ color: brand.navy, fontWeight: 800, fontSize: 13, mb: 0.75 }}>LINES</Typography>
            {lines.length ? lines.map((item) => (
              <Box key={item.id} sx={{ mb: 1 }}>
                <Typography sx={{ fontWeight: 700, fontSize: 14 }}>
                  {item.line_number ? `${item.line_number}. ` : ''}{item.description || 'Line'}
                </Typography>
                <Typography sx={{ fontSize: 13, color: brand.muted, overflowWrap: 'anywhere' }}>
                  {lineSummary(item) || 'No line details'}
                </Typography>
              </Box>
            )) : (
              <Typography sx={{ fontSize: 14, color: brand.muted }}>No line items on this work order.</Typography>
            )}
          </Box>

          <Box>
            <Typography sx={{ color: brand.navy, fontWeight: 800, fontSize: 13, mb: 0.75 }}>INSTRUCTIONS</Typography>
            <Typography sx={{ fontSize: 14, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {instructions || 'No special instructions.'}
            </Typography>
            {routing && (
              <Typography sx={{ fontSize: 14, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', mt: 1 }}>
                Routing: {routing}
              </Typography>
            )}
          </Box>

          <Box>
            <Typography sx={{ color: brand.navy, fontWeight: 800, fontSize: 13, mb: 0.75 }}>HISTORY</Typography>
            {history.length ? history.map((entry) => (
              <Box key={`h-${entry.id}`} sx={{ mb: 1 }}>
                <Typography sx={{ fontSize: 14, fontWeight: 700 }}>
                  {entry.department || '—'} · {boardStatusName(entry.status_label, entry.status)}
                  {entry.manual ? ' · Manual' : ''}
                </Typography>
                <Typography sx={{ fontSize: 12, color: brand.muted }}>
                  {formatHistoryTime(entry.event_time, timeZone)}
                  {entry.scanned_by ? ` · ${entry.scanned_by}` : ''}
                </Typography>
                {entry.notes && (
                  <Typography sx={{ fontSize: 13, overflowWrap: 'anywhere' }}>{entry.notes}</Typography>
                )}
              </Box>
            )) : (
              <Typography sx={{ fontSize: 14, color: brand.muted }}>No production history yet.</Typography>
            )}
            {activity.length > 0 && (
              <Box sx={{ mt: 1.25 }}>
                <Typography sx={{ color: brand.navy, fontWeight: 800, fontSize: 13, mb: 0.75 }}>ACTIVITY</Typography>
                {activity.map((entry) => (
                  <Box key={`a-${entry.id}`} sx={{ mb: 0.75 }}>
                    <Typography sx={{ fontSize: 13 }}>
                      {entry.manual ? 'Manual · ' : ''}{entry.summary}
                    </Typography>
                    <Typography sx={{ fontSize: 12, color: brand.muted }}>
                      {formatHistoryTime(entry.created_at, timeZone)}
                      {entry.actor_name ? ` · ${entry.actor_name}` : ''}
                      {entry.note ? ` · ${entry.note}` : ''}
                    </Typography>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
