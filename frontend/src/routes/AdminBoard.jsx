import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Pagination,
  Popover,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import FilterListIcon from '@mui/icons-material/FilterList';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import QrCode2Icon from '@mui/icons-material/QrCode2';
import AssignmentOutlinedIcon from '@mui/icons-material/AssignmentOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import BrushOutlinedIcon from '@mui/icons-material/BrushOutlined';
import DocumentScannerOutlinedIcon from '@mui/icons-material/DocumentScannerOutlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import { authFetch } from '../api';
import { useAuth } from '../context/AuthContext';
import { brand } from '../brand';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';

const PAGE_SIZE = 8;
const EMPTY_FILTERS = { status: '', priority: '', due_from: '', due_to: '' };

const STAT_ICONS = {
  'Large Format': DescriptionOutlinedIcon,
  'Small Format': ArticleOutlinedIcon,
  'Signs & Graphics': BrushOutlinedIcon,
  Scanning: DocumentScannerOutlinedIcon,
  Planroom: GroupsOutlinedIcon,
};

const ALERT_ICONS = {
  warning: WarningAmberIcon,
  info: InfoOutlinedIcon,
  error: ErrorOutlineIcon,
  success: CheckCircleOutlineIcon,
};

const ALERT_COLORS = {
  warning: '#F9A825',
  info: '#1565C0',
  error: '#C62828',
  success: '#2E7D32',
};

function textOn(hex) {
  const value = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return '#fff';
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return (0.299 * red + 0.587 * green + 0.114 * blue) / 255 > 0.62 ? '#1B2838' : '#fff';
}

function Panel({ title, action, children, badge }) {
  return (
    <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 2, p: 2, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ color: brand.navy, fontWeight: 700 }}>{title}</Typography>
          {badge != null && (
            <Box sx={{ bgcolor: brand.orange, color: '#fff', borderRadius: 10, px: 0.8, fontSize: 12, fontWeight: 700, lineHeight: '18px' }}>
              {badge}
            </Box>
          )}
        </Box>
        {action}
      </Box>
      {children}
    </Box>
  );
}

function linkButton(label, onClick) {
  return (
    <Button size="small" onClick={onClick} sx={{ textTransform: 'none', color: brand.navy, fontWeight: 600, px: 0 }}>
      {label}
    </Button>
  );
}

export default function AdminBoard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canApprove = user?.role === 'admin';
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState('');
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [tableError, setTableError] = useState('');
  const [tableLoading, setTableLoading] = useState(true);
  const [department, setDepartment] = useState('All');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [draftFilters, setDraftFilters] = useState(EMPTY_FILTERS);
  const [filterAnchor, setFilterAnchor] = useState(null);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState({ field: 'arrived', direction: 'desc' });
  const [refreshKey, setRefreshKey] = useState(0);
  const [decisionError, setDecisionError] = useState('');
  const [decidingId, setDecidingId] = useState(null);
  const [approvalDialog, setApprovalDialog] = useState(false);
  const [allApprovals, setAllApprovals] = useState([]);
  const [scanDialog, setScanDialog] = useState(false);
  const [allScans, setAllScans] = useState([]);
  const [dialogError, setDialogError] = useState('');
  const [showAllAlerts, setShowAllAlerts] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = searchInput.trim();
      setQ((current) => {
        if (next !== current) setOffset(0);
        return next;
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    authFetch('/api/admin-board', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load the admin board');
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setSummary(body);
        setSummaryError('');
      })
      .catch((err) => {
        if (cancelled) return;
        setSummaryError(err.message || 'Unable to load the admin board');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setTableLoading(true);
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    params.set('sort', sort.field);
    params.set('direction', sort.direction);
    if (department && department !== 'All') params.set('department', department);
    if (q) params.set('q', q);
    if (filters.status) params.set('status', filters.status);
    if (filters.priority) params.set('priority', filters.priority);
    if (filters.due_from) params.set('due_from', filters.due_from);
    if (filters.due_to) params.set('due_to', filters.due_to);

    authFetch(`/api/admin-board/work-orders?${params.toString()}`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load work orders');
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setRows(body.work_orders || []);
        setTotal(body.total || 0);
        setTableError('');
      })
      .catch((err) => {
        if (cancelled) return;
        setRows([]);
        setTotal(0);
        setTableError(err.message || 'Unable to load work orders');
      })
      .finally(() => {
        if (!cancelled) setTableLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [department, q, filters, offset, sort, refreshKey]);

  useEffect(() => {
    if (!summary?.tabs || department === 'All') return;
    if (!summary.tabs.some((tab) => tab.key === department)) {
      setDepartment('All');
      setOffset(0);
    }
  }, [summary, department]);

  const tabs = summary?.tabs?.length ? summary.tabs : [{ key: 'All', label: 'All', count: 0 }];
  const activeTab = tabs.some((tab) => tab.key === department) ? department : 'All';
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = total === 0 ? 0 : Math.min(offset + rows.length, total);
  const alerts = summary?.alerts || [];
  const visibleAlerts = showAllAlerts ? alerts : alerts.slice(0, 4);
  const tableTitle = activeTab === 'Complete' ? 'Completed Work Orders' : 'Active Work Orders';

  const statCards = useMemo(() => {
    if (!summary?.stats) return [];
    const cards = [
      {
        key: 'total',
        value: summary.stats.total_active,
        label: 'Total Active',
        caption: 'All Departments',
        color: '#1E88E5',
        Icon: AssignmentOutlinedIcon,
      },
    ];
    for (const departmentStat of summary.stats.departments || []) {
      cards.push({
        key: departmentStat.name,
        value: departmentStat.active,
        label: departmentStat.name,
        caption: 'Active',
        color: departmentStat.color || brand.navy,
        Icon: STAT_ICONS[departmentStat.name] || DescriptionOutlinedIcon,
      });
    }
    cards.push({
      key: 'completed',
      value: summary.stats.completed_this_month,
      label: 'Completed',
      caption: 'This Month',
      color: '#78909C',
      Icon: TaskAltIcon,
    });
    return cards;
  }, [summary]);

  function toggleSort(field) {
    setSort((current) => {
      if (current.field === field) {
        return { field, direction: current.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { field, direction: 'asc' };
    });
    setOffset(0);
  }

  async function decide(id, decision) {
    setDecisionError('');
    setDecidingId(id);
    try {
      const response = await authFetch(`/api/admin-board/approvals/${id}`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to update the approval');
      setRefreshKey((value) => value + 1);
      if (approvalDialog) {
        setAllApprovals((current) => current.filter((item) => item.id !== id));
      }
    } catch (err) {
      setDecisionError(err.message || 'Unable to update the approval');
    } finally {
      setDecidingId(null);
    }
  }

  async function openApprovals() {
    setDialogError('');
    setApprovalDialog(true);
    try {
      const response = await authFetch('/api/admin-board/approvals?limit=100', { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to load approvals');
      setAllApprovals(body.approvals || []);
    } catch (err) {
      setDialogError(err.message || 'Unable to load approvals');
    }
  }

  async function openScans() {
    setDialogError('');
    setScanDialog(true);
    try {
      const response = await authFetch('/api/barcode/events?limit=50', { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to load scans');
      setAllScans(body.events || []);
    } catch (err) {
      setDialogError(err.message || 'Unable to load scans');
    }
  }

  function renderApprovals(items, emptyLabel) {
    if (!items.length) {
      return <Typography color="text.secondary" sx={{ fontSize: 14 }}>{emptyLabel}</Typography>;
    }
    return (
      <Box sx={{ display: 'grid', gap: 1.25 }}>
        {items.map((item) => (
          <Box key={item.id} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) auto' }, gap: 1, alignItems: 'center' }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontWeight: 700, fontSize: 14 }}>{item.external_id}</Typography>
              <Typography sx={{ fontSize: 13, color: brand.muted }}>
                {item.type} · {item.requested_by || 'Unknown'} · {item.requested_display || '—'}
              </Typography>
            </Box>
            {canApprove && (
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button
                  size="small"
                  variant="contained"
                  disabled={decidingId === item.id}
                  onClick={() => decide(item.id, 'approved')}
                  sx={{ bgcolor: brand.green, '&:hover': { bgcolor: brand.greenDark }, textTransform: 'none' }}
                >
                  Approve
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  color="inherit"
                  disabled={decidingId === item.id}
                  onClick={() => decide(item.id, 'rejected')}
                  sx={{ textTransform: 'none' }}
                >
                  Reject
                </Button>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    );
  }

  if (loading && !summary) return <LoadingState message="Loading the admin board..." />;
  if (summaryError && !summary) return <ErrorState message={summaryError} />;

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Tabs
        value={activeTab}
        onChange={(_, value) => {
          setDepartment(value);
          setOffset(0);
        }}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{
          minHeight: 42,
          '& .MuiTabs-indicator': { bgcolor: brand.orange, height: 3 },
          '& .MuiTab-root': { textTransform: 'none', minHeight: 42, fontWeight: 600, color: brand.muted, px: 1.5 },
          '& .Mui-selected': { color: brand.orange },
        }}
      >
        {tabs.map((tab) => (
          <Tab key={tab.key} value={tab.key} label={`${tab.label} [${tab.count}]`} />
        ))}
      </Tabs>

      <Box
        sx={{
          display: 'grid',
          gap: 1.5,
          gridTemplateColumns: {
            xs: '1fr',
            sm: '1fr 1fr',
            md: 'repeat(3, minmax(0, 1fr))',
            lg: 'repeat(4, minmax(0, 1fr))',
            xl: 'repeat(7, minmax(0, 1fr))',
          },
        }}
      >
        {statCards.map((card) => (
          <Box key={card.key} sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 2, p: 1.5, display: 'flex', gap: 1.25, alignItems: 'center', minHeight: 84 }}>
            <Box sx={{ width: 42, height: 42, borderRadius: '50%', bgcolor: card.color, color: textOn(card.color), display: 'grid', placeItems: 'center', flexShrink: 0 }}>
              <card.Icon fontSize="small" />
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontSize: 26, fontWeight: 700, lineHeight: 1, color: brand.text }}>{card.value}</Typography>
              <Typography sx={{ fontSize: 13, fontWeight: 700, color: brand.text }} noWrap>{card.label}</Typography>
              <Typography sx={{ fontSize: 12, color: brand.muted }}>{card.caption}</Typography>
            </Box>
          </Box>
        ))}
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 300px' }, gap: 2, alignItems: 'start' }}>
        <Box sx={{ display: 'grid', gap: 2, minWidth: 0 }}>
          <Panel
            title={tableTitle}
            action={(
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <TextField
                  size="small"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Search orders..."
                  aria-label="Search orders"
                  InputProps={{ startAdornment: <SearchIcon sx={{ color: brand.muted, mr: 0.5 }} fontSize="small" /> }}
                  sx={{ width: { xs: 160, sm: 220 }, bgcolor: '#fff' }}
                />
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<FilterListIcon />}
                  onClick={(event) => {
                    setDraftFilters(filters);
                    setFilterAnchor(event.currentTarget);
                  }}
                  sx={{ textTransform: 'none', borderColor: brand.border, color: brand.text }}
                >
                  Filters
                </Button>
              </Box>
            )}
          >
            {tableError && <Alert severity="error" sx={{ mb: 1 }}>{tableError}</Alert>}
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" sx={{ minWidth: 760 }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ color: brand.navy, fontWeight: 700 }}>Order #</TableCell>
                    <TableCell sx={{ color: brand.navy, fontWeight: 700 }}>Company</TableCell>
                    <TableCell sx={{ color: brand.navy, fontWeight: 700 }}>Contact</TableCell>
                    <TableCell sx={{ color: brand.navy, fontWeight: 700 }}>Originals</TableCell>
                    <TableCell sx={{ color: brand.navy, fontWeight: 700 }}>Department</TableCell>
                    <TableCell sx={{ color: brand.navy, fontWeight: 700 }} sortDirection={sort.field === 'arrived' ? sort.direction : false}>
                      <TableSortLabel
                        active={sort.field === 'arrived'}
                        direction={sort.field === 'arrived' ? sort.direction : 'asc'}
                        onClick={() => toggleSort('arrived')}
                      >
                        Arrived
                      </TableSortLabel>
                    </TableCell>
                    <TableCell sx={{ color: brand.navy, fontWeight: 700 }} sortDirection={sort.field === 'due' ? sort.direction : false}>
                      <TableSortLabel
                        active={sort.field === 'due'}
                        direction={sort.field === 'due' ? sort.direction : 'asc'}
                        onClick={() => toggleSort('due')}
                      >
                        Due
                      </TableSortLabel>
                    </TableCell>
                    <TableCell sx={{ color: brand.navy, fontWeight: 700 }}>Process</TableCell>
                    <TableCell sx={{ color: brand.navy, fontWeight: 700 }}>Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.length ? rows.map((row) => (
                    <TableRow key={row.id} hover>
                      <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{row.order_number}</TableCell>
                      <TableCell>{row.company || '—'}</TableCell>
                      <TableCell>{row.contact_name || '—'}</TableCell>
                      <TableCell>{row.originals_source_label || 'Not specified'}</TableCell>
                      <TableCell>
                        <Chip
                          label={row.department || 'Unassigned'}
                          size="small"
                          sx={{
                            bgcolor: row.department_color || '#90caf9',
                            color: textOn(row.department_color),
                            fontWeight: 700,
                            borderRadius: 1,
                          }}
                        />
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{row.arrived_display || '—'}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{row.due_display || '—'}</TableCell>
                      <TableCell>{row.process || '—'}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        <IconButton aria-label={`View ${row.order_number}`} size="small" onClick={() => navigate(`/work-orders/${row.id}`)}>
                          <VisibilityOutlinedIcon fontSize="small" />
                        </IconButton>
                        <IconButton aria-label={`Print barcode for ${row.order_number}`} size="small" onClick={() => navigate(`/work-orders/${row.id}/print`)}>
                          <QrCode2Icon fontSize="small" />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  )) : (
                    <TableRow>
                      <TableCell colSpan={9} sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
                        {tableLoading ? 'Loading work orders...' : 'No work orders match this view.'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, flexWrap: 'wrap', pt: 1.5 }}>
              <Typography sx={{ fontSize: 13, color: brand.muted }}>
                Showing {showingFrom} to {showingTo} of {total}
              </Typography>
              {total > PAGE_SIZE && (
                <Pagination
                  count={pageCount}
                  page={Math.min(page, pageCount)}
                  onChange={(_, nextPage) => setOffset((nextPage - 1) * PAGE_SIZE)}
                  shape="rounded"
                  size="small"
                />
              )}
            </Box>
          </Panel>

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
            <Panel title="Scan Activity (Last 10 Scans)" action={linkButton('View Full Scan History', openScans)}>
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small" sx={{ minWidth: 420 }}>
                  <TableHead>
                    <TableRow>
                      {['Time', 'Order #', 'From', 'To', 'Scanned By'].map((label) => (
                        <TableCell key={label} sx={{ color: brand.navy, fontWeight: 700, fontSize: 12 }}>{label}</TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(summary?.scans || []).length ? summary.scans.map((scan) => (
                      <TableRow key={scan.id}>
                        <TableCell sx={{ fontSize: 12, whiteSpace: 'nowrap' }}>{scan.event_display || '—'}</TableCell>
                        <TableCell sx={{ fontSize: 12 }}>{scan.external_id}</TableCell>
                        <TableCell sx={{ fontSize: 12 }}>{scan.from_department || '—'}</TableCell>
                        <TableCell sx={{ fontSize: 12 }}>
                          {scan.to_department || '—'}
                          {!scan.to_department && scan.location ? (
                            <Typography component="div" sx={{ fontSize: 11, color: brand.muted }}>location: {scan.location}</Typography>
                          ) : null}
                        </TableCell>
                        <TableCell sx={{ fontSize: 12 }}>{scan.scanned_by}</TableCell>
                      </TableRow>
                    )) : (
                      <TableRow>
                        <TableCell colSpan={5} sx={{ color: 'text.secondary', fontSize: 13 }}>No scans recorded yet.</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </Box>
            </Panel>

            <Panel
              title="Pending Approvals"
              badge={summary?.approvals_total || null}
              action={linkButton('View All Pending Approvals', openApprovals)}
            >
              {decisionError && <Alert severity="error" sx={{ mb: 1 }}>{decisionError}</Alert>}
              {renderApprovals(summary?.approvals || [], 'No requests are waiting for approval.')}
              {!canApprove && (summary?.approvals_total || 0) > 0 && (
                <Typography sx={{ mt: 1, fontSize: 12, color: brand.muted }}>An administrator approves or rejects these requests.</Typography>
              )}
            </Panel>
          </Box>
        </Box>

        <Box sx={{ display: 'grid', gap: 2, alignContent: 'start' }}>
          <Panel title="Department Queue Summary">
            <Box sx={{ display: 'grid', gap: 0.75 }}>
              {(summary?.queue || []).map((item) => (
                <Box key={item.name} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                    <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: item.color || brand.navy, flexShrink: 0 }} />
                    <Typography sx={{ fontSize: 14 }} noWrap>{item.name}</Typography>
                  </Box>
                  <Typography sx={{ fontSize: 14, fontWeight: 700 }}>{item.count}</Typography>
                </Box>
              ))}
            </Box>
          </Panel>

          <Panel title="Recent Activity" action={linkButton('View All Activity', () => navigate('/activity-log'))}>
            <Box sx={{ display: 'grid', gap: 1.25 }}>
              {(summary?.activity || []).length ? summary.activity.map((item) => (
                <Box key={item.id}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                    <Typography
                      sx={{ fontWeight: 700, fontSize: 14, color: item.entity_type === 'work_order' ? brand.navy : brand.text, cursor: item.entity_type === 'work_order' ? 'pointer' : 'default' }}
                      onClick={() => {
                        if (item.entity_type === 'work_order' && item.entity_id) navigate(`/work-orders/${item.entity_id}`);
                        if (item.entity_type === 'order' && item.entity_id) navigate(`/orders/${item.entity_id}`);
                      }}
                    >
                      {item.external_id || item.summary}
                    </Typography>
                    <Typography sx={{ fontSize: 12, color: brand.muted, whiteSpace: 'nowrap' }}>{item.created_display || ''}</Typography>
                  </Box>
                  {item.external_id && (
                    <Typography sx={{ fontSize: 13 }}>{item.summary}</Typography>
                  )}
                  <Typography sx={{ fontSize: 12, color: brand.muted }}>by {item.actor_name}</Typography>
                </Box>
              )) : (
                <Typography color="text.secondary" sx={{ fontSize: 14 }}>No activity recorded yet.</Typography>
              )}
            </Box>
          </Panel>

          <Panel
            title="System Alerts"
            action={alerts.length > 4 ? linkButton(showAllAlerts ? 'Show Fewer' : 'View All Alerts', () => setShowAllAlerts((value) => !value)) : null}
          >
            <Box sx={{ display: 'grid', gap: 1.25 }}>
              {visibleAlerts.length ? visibleAlerts.map((alert) => {
                const Icon = ALERT_ICONS[alert.severity] || InfoOutlinedIcon;
                const color = ALERT_COLORS[alert.severity] || brand.navy;
                return (
                  <Box key={alert.id} sx={{ display: 'flex', gap: 1 }}>
                    <Icon sx={{ color, fontSize: 20, mt: 0.2 }} />
                    <Box>
                      <Typography sx={{ fontSize: 14, fontWeight: 700 }}>{alert.message}</Typography>
                      {alert.detail && <Typography sx={{ fontSize: 13, color: brand.muted }}>{alert.detail}</Typography>}
                      {alert.relative && <Typography sx={{ fontSize: 12, color: brand.muted }}>{alert.relative}</Typography>}
                    </Box>
                  </Box>
                );
              }) : (
                <Typography color="text.secondary" sx={{ fontSize: 14 }}>No alerts.</Typography>
              )}
            </Box>
          </Panel>
        </Box>
      </Box>

      <Popover
        open={Boolean(filterAnchor)}
        anchorEl={filterAnchor}
        onClose={() => setFilterAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Box sx={{ p: 2, width: 280, display: 'grid', gap: 1.5 }}>
          <TextField
            select
            size="small"
            label="Status"
            value={draftFilters.status}
            onChange={(event) => setDraftFilters((current) => ({ ...current, status: event.target.value }))}
          >
            <MenuItem value="">Any</MenuItem>
            <MenuItem value="open">Open</MenuItem>
            <MenuItem value="in-progress">In progress</MenuItem>
            <MenuItem value="on-hold">On hold</MenuItem>
            <MenuItem value="completed">Completed</MenuItem>
          </TextField>
          <TextField
            select
            size="small"
            label="Priority"
            value={draftFilters.priority}
            onChange={(event) => setDraftFilters((current) => ({ ...current, priority: event.target.value }))}
          >
            <MenuItem value="">Any</MenuItem>
            {['Low', 'Normal', 'High', 'Rush'].map((priority) => (
              <MenuItem key={priority} value={priority}>{priority}</MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="Due from"
            type="date"
            value={draftFilters.due_from}
            onChange={(event) => setDraftFilters((current) => ({ ...current, due_from: event.target.value }))}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            size="small"
            label="Due to"
            type="date"
            value={draftFilters.due_to}
            onChange={(event) => setDraftFilters((current) => ({ ...current, due_to: event.target.value }))}
            InputLabelProps={{ shrink: true }}
          />
          <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
            <Button
              size="small"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setDraftFilters(EMPTY_FILTERS);
                setOffset(0);
                setFilterAnchor(null);
              }}
            >
              Clear
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => {
                setFilters(draftFilters);
                setOffset(0);
                setFilterAnchor(null);
              }}
              sx={{ bgcolor: brand.navy }}
            >
              Apply
            </Button>
          </Box>
        </Box>
      </Popover>

      <Dialog open={approvalDialog} onClose={() => setApprovalDialog(false)} fullWidth maxWidth="sm">
        <DialogTitle>Pending Approvals</DialogTitle>
        <DialogContent>
          {dialogError && <Alert severity="error" sx={{ mb: 1 }}>{dialogError}</Alert>}
          {renderApprovals(allApprovals, 'No requests are waiting for approval.')}
        </DialogContent>
      </Dialog>

      <Dialog open={scanDialog} onClose={() => setScanDialog(false)} fullWidth maxWidth="md">
        <DialogTitle>Scan History</DialogTitle>
        <DialogContent>
          {dialogError && <Alert severity="error" sx={{ mb: 1 }}>{dialogError}</Alert>}
          <Table size="small">
            <TableHead>
              <TableRow>
                {['Time', 'Order #', 'From', 'To', 'Location', 'Scanned By'].map((label) => (
                  <TableCell key={label}>{label}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {allScans.length ? allScans.map((scan) => (
                <TableRow key={scan.id}>
                  <TableCell>{scan.event_time || '—'}</TableCell>
                  <TableCell>{scan.external_id || scan.scanned_value || '—'}</TableCell>
                  <TableCell>{scan.from_department || '—'}</TableCell>
                  <TableCell>{scan.to_department || '—'}</TableCell>
                  <TableCell>{scan.location || '—'}</TableCell>
                  <TableCell>{scan.operator_name || scan.operator_username || '—'}</TableCell>
                </TableRow>
              )) : (
                <TableRow>
                  <TableCell colSpan={6}>No scans recorded yet.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </Box>
  );
}
