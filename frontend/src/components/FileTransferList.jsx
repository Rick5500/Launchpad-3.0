import React, { useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Box, Button, Typography } from '@mui/material';
import { authFetch, downloadAuthorized } from '../api';
import { brand, formatFileSize, formatShopStamp } from '../brand';

export function downloadStateLabel(downloadedAt, timeZone) {
  if (!downloadedAt) return 'Not yet';
  const stamp = formatShopStamp(downloadedAt, timeZone);
  return stamp ? `Downloaded by customer · ${stamp}` : 'Downloaded by customer';
}

function transferTitle(transfer) {
  if (transfer.subject) return transfer.subject;
  if (transfer.order_number) return `Files for order ${transfer.order_number}`;
  return 'Files from Accent';
}

export default function FileTransferList({
  transfers,
  timeZone,
  canManage = false,
  highlightId = null,
  onChanged,
  emptyText = 'No files from Accent yet.',
}) {
  const replaceRef = useRef(null);
  const [replacingId, setReplacingId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function download(file) {
    setError('');
    try {
      await downloadAuthorized(`/api/shared-files/${file.id}/download`, file.original_name);
      if (!canManage && onChanged) await onChanged();
    } catch (err) {
      setError(err.message || 'Download failed');
    }
  }

  async function removeFile(file) {
    if (!window.confirm(`Remove ${file.original_name}? The activity log keeps the record.`)) return;
    setError('');
    const response = await authFetch(`/api/shared-files/${file.id}`, { method: 'DELETE' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error || 'Unable to remove file');
      return;
    }
    setNotice('File removed.');
    if (onChanged) await onChanged();
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
      if (onChanged) await onChanged();
    } catch (err) {
      setError(err.message || 'Unable to replace file');
    }
  }

  return (
    <Box sx={{ display: 'grid', gap: 1.5, minWidth: 0 }}>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {notice ? <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert> : null}
      {!transfers.length ? <Typography color="text.secondary">{emptyText}</Typography> : null}
      {transfers.map((transfer) => {
        const highlighted = highlightId != null && String(highlightId) === String(transfer.id);
        return (
          <Box
            key={transfer.id}
            id={`transfer-${transfer.id}`}
            data-testid="transfer-row"
            sx={{
              border: `1px solid ${highlighted ? brand.orange : brand.border}`,
              borderRadius: 1,
              p: { xs: 1.25, sm: 1.5 },
              bgcolor: '#fff',
              minWidth: 0,
              boxShadow: highlighted ? `inset 4px 0 0 ${brand.orange}` : 'none',
            }}
          >
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontWeight: 800, color: brand.navy, overflowWrap: 'anywhere' }}>
                  {transferTitle(transfer)}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                  {transfer.customer_name ? `${transfer.customer_name} · ` : ''}
                  {formatShopStamp(transfer.created_at, timeZone) || transfer.created_at}
                  {transfer.sender_name ? ` · ${transfer.sender_name}` : ''}
                </Typography>
              </Box>
              {canManage ? (
                <Typography
                  variant="body2"
                  data-testid="customer-download-state"
                  sx={{ fontWeight: 700, color: transfer.downloaded_by_customer ? brand.greenDark : brand.muted }}
                >
                  {downloadStateLabel(transfer.customer_downloaded_at, timeZone)}
                </Typography>
              ) : null}
            </Box>
            {transfer.message ? (
              <Typography sx={{ mt: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{transfer.message}</Typography>
            ) : null}
            {transfer.order_id ? (
              <Button
                component={RouterLink}
                to={`/orders/${transfer.order_id}`}
                data-testid="transfer-order-link"
                size="small"
                sx={{ mt: 0.5, px: 0, color: brand.navy, fontWeight: 700, justifyContent: 'flex-start' }}
              >
                Order {transfer.order_number || transfer.order_id}
              </Button>
            ) : null}
            {(transfer.files || []).map((file) => (
              <Box
                key={file.id}
                data-testid="shared-file-row"
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 1,
                  py: 0.75,
                  flexWrap: 'wrap',
                  borderTop: `1px solid ${brand.border}`,
                  mt: 1,
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{file.original_name}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {formatFileSize(file.size_bytes)}
                    {file.work_order_number ? ` · ${file.work_order_number}` : ''}
                  </Typography>
                  {canManage ? (
                    <Typography variant="body2" sx={{ color: file.downloaded_by_customer ? brand.greenDark : brand.muted }}>
                      {downloadStateLabel(file.customer_downloaded_at, timeZone)}
                    </Typography>
                  ) : null}
                </Box>
                <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
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
        );
      })}
      <input ref={replaceRef} type="file" hidden onChange={onReplace} />
    </Box>
  );
}
