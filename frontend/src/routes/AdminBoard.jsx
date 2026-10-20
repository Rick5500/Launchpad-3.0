import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Snackbar,
  MenuItem,
  Pagination,
  Popover,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
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
import { BOARD_REFRESH_EVENT, requestBoardRefresh } from '../boardEvents';
import MoveWorkOrderDialog from '../components/MoveWorkOrderDialog';
import BoardDetailPane from '../components/BoardDetailPane';
import { UrgencyChips, UrgencyLegend, rowSurface, splitInstant, splitWall } from '../components/boardUrgency';
import { useAuth } from '../context/AuthContext';
import { brand } from '../brand';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';

const PAGE_SIZE = 8;
const EMPTY_FILTERS = { status: '', priority: '', category: '', due_from: '', due_to: '' };
const BOARD_CATEGORY_OPTIONS = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'new', label: 'New' },
  { value: 'in_production', label: 'In Production' },
];
const MONITOR_TABS = new Set(['All', 'Active', 'Search']);
const headCellSx = {
  color: '#fff',
  fontWeight: 700,
  bgcolor: brand.navy,
  borderBottom: 0,
  whiteSpace: 'nowrap',
  fontSize: 13,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
// Launch Pad 2.0 did not record a refresh interval in this repo. Sixty seconds
// keeps a shop monitor current without moving focus or clearing the table.
const BOARD_POLL_MS = 60000;

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

function withMonitorTabs(apiTabs, restricted) {
  const source = apiTabs?.length ? apiTabs : [{ key: 'All', label: 'All', count: 0 }];
  const departments = source.filter((tab) => tab.key !== 'Search' && tab.key !== 'Active');
  const activeCount = (departments.find((tab) => tab.key === 'All') || departments[0] || {}).count ?? 0;
  const extras = [
    { key: 'Search', label: 'Search', count: null },
    { key: 'Active', label: 'Active', count: activeCount },
  ];
  if (restricted) {
    const own = departments.filter((tab) => tab.key !== 'All');
    return [...(own.length ? own : departments), ...extras];
  }
  return [...departments, ...extras];
}

function StackedStamp({ date, time, missing = '—' }) {
  if (!date && !time) {
    return <Box sx={{ textAlign: 'center', whiteSpace: 'nowrap' }}>{missing}</Box>;
  }
  return (
    <Box sx={{ textAlign: 'center', lineHeight: 1.25, whiteSpace: 'nowrap' }}>
      <div>{date}</div>
      {time ? <div>{time}</div> : null}
    </Box>
  );
}

function SelectTransferPrompt() {
  return (
    <Box
      data-testid="board-detail-empty"
      sx={{
        minHeight: { xs: 220, md: 420 },
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        px: 3,
        textAlign: 'center',
        bgcolor: '#fff',
        border: `1px solid ${brand.border}`,
        borderRadius: 1,
      }}
    >
      <Box
        component="svg"
        viewBox="0 0 140 90"
        aria-hidden="true"
        sx={{ width: 140, height: 90 }}
      >
        <path
          d="M124 18 C 78 16, 46 48, 34 62"
          fill="none"
          stroke="#E23B2F"
          strokeWidth="7"
          strokeLinecap="round"
        />
        <path
          d="M18 42 L32 70 L58 54"
          fill="none"
          stroke="#E23B2F"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Box>
      <Typography sx={{ fontSize: { xs: 20, md: 26 }, color: '#1565C0', fontWeight: 500, maxWidth: 320, lineHeight: 1.25 }}>
        Select a transfer for more info about it.
      </Typography>
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
  const canMove = user?.role === 'admin' || user?.role === 'manager';
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState('');
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [tableError, setTableError] = useState('');
  const [tableLoading, setTableLoading] = useState(true);
  const [department, setDepartment] = useState('Active');
  const [viewAll, setViewAll] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [draftFilters, setDraftFilters] = useState(EMPTY_FILTERS);
  const [filterAnchor, setFilterAnchor] = useState(null);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState({ field: 'due', direction: 'asc' });
  const [showStats, setShowStats] = useState(false);
  const completeSortApplied = useRef(false);
  const searchRef = useRef(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [decisionError, setDecisionError] = useState('');
  const [decidingId, setDecidingId] = useState(null);
  const [approvalDialog, setApprovalDialog] = useState(false);
  const [allApprovals, setAllApprovals] = useState([]);
  const [scanDialog, setScanDialog] = useState(false);
  const [allScans, setAllScans] = useState([]);
  const [dialogError, setDialogError] = useState('');
  const [showAllAlerts, setShowAllAlerts] = useState(false);
  const [moveTarget, setMoveTarget] = useState(null);
  const [moveNotice, setMoveNotice] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedRow, setSelectedRow] = useState(null);
  const [boardZone, setBoardZone] = useState('');
  const detailRef = useRef(null);

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
    const summaryPath = viewAll ? '/api/admin-board?scope=all' : '/api/admin-board';
    authFetch(summaryPath, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load the dashboard');
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setSummary(body);
        setSummaryError('');
      })
      .catch((err) => {
        if (cancelled) return;
        setSummaryError(err.message || 'Unable to load the dashboard');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, viewAll]);

  useEffect(() => {
    let cancelled = false;
    setTableLoading(true);
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    params.set('sort', sort.field);
    params.set('direction', sort.direction);
    const locked = Boolean(summary?.viewer?.restricted) && !viewAll;
    if (viewAll) params.set('scope', 'all');
    if (!locked && department && !MONITOR_TABS.has(department)) params.set('department', department);
    if (q) params.set('q', q);
    if (filters.status) params.set('status', filters.status);
    if (filters.priority) params.set('priority', filters.priority);
    if (filters.category) params.set('category', filters.category);
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
        setBoardZone(body.timezone || '');
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
  }, [department, q, filters, offset, sort, refreshKey, viewAll, summary?.viewer?.restricted]);

  useEffect(() => {
    if (!summary?.viewer?.restricted || viewAll || !summary.viewer.department) return;
    setDepartment((current) => {
      if (current === 'Search' || current === 'Active') return current;
      return summary.viewer.department;
    });
  }, [summary, viewAll]);

  useEffect(() => {
    if (completeSortApplied.current) return;
    if (summary?.viewer?.filter !== 'completed this month') return;
    completeSortApplied.current = true;
    setSort({ field: 'arrived', direction: 'desc' });
  }, [summary]);

  useEffect(() => {
    if (!summary?.tabs || MONITOR_TABS.has(department)) return;
    if (summary?.viewer?.restricted && !viewAll) {
      if (department !== summary.viewer.department) {
        setDepartment(summary.viewer.department);
        setOffset(0);
      }
      return;
    }
    if (!summary.tabs.some((tab) => tab.key === department)) {
      setDepartment('Active');
      setOffset(0);
    }
  }, [summary, department, viewAll]);

  useEffect(() => {
    function onBoardRefresh() {
      setRefreshKey((value) => value + 1);
    }
    window.addEventListener(BOARD_REFRESH_EVENT, onBoardRefresh);
    return () => window.removeEventListener(BOARD_REFRESH_EVENT, onBoardRefresh);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setRefreshKey((value) => value + 1);
    }, BOARD_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const fresh = rows.find((row) => row.id === selectedId);
    if (fresh) setSelectedRow(fresh);
  }, [rows, selectedId]);

  useEffect(() => {
    if (!selectedId || !detailRef.current) return;
    if (window.innerWidth < 1200) {
      detailRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedId]);

  useEffect(() => {
    let timer = 0;
    function scheduleRefresh() {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setRefreshKey((value) => value + 1);
      }, 50);
    }
    function onVisible() {
      if (document.visibilityState === 'visible') scheduleRefresh();
    }
    window.addEventListener('focus', scheduleRefresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', scheduleRefresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const lockedView = Boolean(summary?.viewer?.restricted) && !viewAll;
  const tabs = withMonitorTabs(summary?.tabs, lockedView);
  const activeTab = tabs.some((tab) => tab.key === department) ? department : tabs[0].key;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = total === 0 ? 0 : Math.min(offset + rows.length, total);
  const alerts = summary?.alerts || [];
  const visibleAlerts = showAllAlerts ? alerts : alerts.slice(0, 4);
  const statCards = useMemo(() => {
    if (!summary?.stats) return [];
    const categories = summary.stats.categories || {};
    const cards = [
      {
        key: 'total',
        value: summary.stats.total_active,
        label: 'Total Active',
        caption: summary?.viewer?.restricted ? summary.viewer.department : 'All Departments',
        color: '#1E88E5',
        Icon: AssignmentOutlinedIcon,
      },
      {
        key: 'category-overdue',
        value: categories.overdue || 0,
        label: 'Overdue',
        caption: 'Category',
        color: '#E53935',
        Icon: ErrorOutlineIcon,
      },
      {
        key: 'category-new',
        value: categories.new || 0,
        label: 'New',
        caption: 'Category',
        color: '#F9A825',
        Icon: AssignmentOutlinedIcon,
      },
      {
        key: 'category-in-production',
        value: categories.in_production || 0,
        label: 'In Production',
        caption: 'Category',
        color: '#1565C0',
        Icon: DescriptionOutlinedIcon,
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

  if (loading && !summary) return <LoadingState message="Loading the dashboard..." />;
  if (summaryError && !summary) return <ErrorState message={summaryError} />;

  function toggleDepartmentScope() {
    setViewAll((current) => !current);
    setDepartment('Active');
    setOffset(0);
  }

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      {(summary?.viewer?.restricted || summary?.viewer?.can_clear) && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          {summary.viewer.restricted && (
            <Chip
              color="primary"
              label={summary.viewer.filter
                ? `Showing: ${summary.viewer.department} · ${summary.viewer.filter}`
                : `Showing: ${summary.viewer.department}`}
              sx={{ fontWeight: 700 }}
            />
          )}
          {summary.viewer.can_clear && (
            <Button
              size="small"
              variant="outlined"
              onClick={toggleDepartmentScope}
              sx={{ textTransform: 'none' }}
            >
              {viewAll ? `Show ${summary.viewer.department}` : 'All departments'}
            </Button>
          )}
        </Box>
      )}
      <Tabs
        value={activeTab}
        onChange={(_, value) => {
          if (lockedView && value !== 'Search' && value !== 'Active' && value !== summary?.viewer?.department) return;
          setDepartment(value);
          setOffset(0);
          if (value === 'Search') window.setTimeout(() => searchRef.current?.focus(), 0);
        }}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{
          minHeight: 36,
          bgcolor: '#f3f6fb',
          borderBottom: `1px solid ${brand.border}`,
          '& .MuiTabs-indicator': { bgcolor: brand.orange, height: 3 },
          '& .MuiTab-root': { textTransform: 'none', minHeight: 36, fontWeight: 700, color: brand.navy, px: 1.25 },
          '& .Mui-selected': { color: brand.orange },
        }}
      >
        {tabs.map((tab) => (
          <Tab key={tab.key} value={tab.key} label={tab.label} />
        ))}
      </Tabs>

      {showStats && (
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
      )}

      <Box sx={{ display: 'flex', justifyContent: 'center' }}>
        <Button
          size="small"
          variant="outlined"
          data-testid="board-options"
          onClick={(event) => {
            setDraftFilters(filters);
            setFilterAnchor(event.currentTarget);
          }}
          sx={{ textTransform: 'none', borderColor: '#9bb0c9', color: brand.navy, bgcolor: '#f7f9fc', fontWeight: 700, px: 2 }}
        >
          Options
        </Button>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gap: 1.5,
          alignItems: 'start',
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) minmax(280px, 360px)' },
        }}
      >
        <Box sx={{ display: 'grid', gap: 2, minWidth: 0, gridColumn: '1', gridRow: 1 }}>
          <Box sx={{ minWidth: 0 }}>
            {activeTab === 'Search' && (
              <TextField
                inputRef={searchRef}
                size="small"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search transfers..."
                aria-label="Search orders"
                data-testid="board-search"
                InputProps={{ startAdornment: <SearchIcon sx={{ color: brand.muted, mr: 0.5 }} fontSize="small" /> }}
                sx={{ width: { xs: '100%', sm: 360 }, bgcolor: '#fff', mb: 1 }}
              />
            )}
            {tableError && <Alert severity="error" sx={{ mb: 1 }}>{tableError}</Alert>}
            <Box sx={{ mb: 1 }}>
              <UrgencyLegend timezone={boardZone} />
            </Box>
            <Box data-testid="board-table-wrap" sx={{ overflowX: 'auto', bgcolor: '#fff', border: `1px solid ${brand.border}` }}>
              <Table
                size="small"
                sx={{
                  width: '100%',
                  tableLayout: 'fixed',
                  minWidth: { xs: 0, xl: 760 },
                }}
              >
                <colgroup>
                  <col style={{ width: '16%' }} />
                  <col style={{ width: '13%' }} />
                  <col style={{ width: '17%' }} />
                  <col style={{ width: '18%' }} />
                  <col style={{ width: '20%' }} />
                  <col style={{ width: '16%' }} />
                </colgroup>
                <TableHead sx={{ '& .MuiTableCell-root': { px: { xs: 0.5, xl: 1.25 } } }}>
                  <TableRow>
                    <TableCell sx={headCellSx} title="XFer Id/From">XFer Id/From</TableCell>
                    {['To', 'Arrived', 'Retrieved'].map((label) => (
                      <TableCell key={label} sx={headCellSx}>{label}</TableCell>
                    ))}
                    <TableCell sx={headCellSx} sortDirection={sort.field === 'due' ? sort.direction : false}>
                      <TableSortLabel
                        active={sort.field === 'due'}
                        direction={sort.field === 'due' ? sort.direction : 'asc'}
                        onClick={() => toggleSort('due')}
                        sx={{
                          color: '#fff !important',
                          '& .MuiTableSortLabel-icon': { color: '#fff !important' },
                        }}
                      >
                        Date Due
                      </TableSortLabel>
                    </TableCell>
                    <TableCell sx={headCellSx}>Process</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.length ? rows.map((row, index) => {
                    const surface = rowSurface(row, index);
                    const fresh = !row.retrieved_at;
                    const signalText = [...(row.urgency?.signals || []), ...(fresh ? ['New'] : [])].join(', ');
                    const arrived = splitInstant(row.arrived_at, boardZone);
                    const retrieved = splitInstant(row.retrieved_at, boardZone, { seconds: true });
                    const due = splitWall(row.due_at);
                    const weight = surface.bold ? 800 : 500;
                    return (
                    <TableRow
                      key={row.id}
                      tabIndex={0}
                      role="row"
                      aria-selected={selectedId === row.id}
                      selected={selectedId === row.id}
                      data-testid={`board-row-${row.external_id || row.id}`}
                      data-urgency={row.urgency?.tone || 'none'}
                      data-retrieved={fresh ? 'no' : 'yes'}
                      onClick={() => {
                        setSelectedId(row.id);
                        setSelectedRow(row);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        setSelectedId(row.id);
                        setSelectedRow(row);
                      }}
                      sx={{
                        cursor: 'pointer',
                        background: surface.background,
                        fontWeight: weight,
                        color: '#1B2838',
                        boxShadow: selectedId === row.id ? `inset 0 0 0 2px ${brand.navy}` : undefined,
                        '&:hover': { filter: 'brightness(0.97)' },
                        '&:focus-visible': {
                          outline: `2px solid ${brand.navy}`,
                          outlineOffset: -2,
                        },
                        '& .MuiTableCell-root': {
                          borderBottom: '1px solid rgba(27,40,56,0.08)',
                          fontWeight: weight,
                          color: '#1B2838',
                          fontSize: 13,
                          py: 0.75,
                          px: { xs: 0.5, xl: 1.25 },
                          overflow: 'hidden',
                        },
                      }}
                    >
                      <TableCell>
                        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.15, minWidth: 0 }} aria-label={signalText || undefined}>
                          <Box component="span" title={row.order_number || undefined} sx={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.order_number}</Box>
                          <Box component="span" title={row.company || undefined} sx={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.company || '—'}</Box>
                          <Box component="span" title={row.contact_name || undefined} sx={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.contact_name || '—'}</Box>
                          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.4, mt: 0.35 }}>
                            <UrgencyChips urgency={row.urgency} fresh={fresh} />
                          </Box>
                        </Box>
                      </TableCell>
                      <TableCell>
                        <Box
                          component="span"
                          sx={{
                            display: 'inline-block',
                            maxWidth: '100%',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            bgcolor: row.department_color || '#90caf9',
                            color: textOn(row.department_color),
                            fontWeight: 800,
                            fontSize: 12,
                            lineHeight: 1.3,
                            px: 0.9,
                            py: 0.3,
                            borderRadius: 0.5,
                            boxSizing: 'border-box',
                          }}
                          title={row.department || 'Unassigned'}
                        >
                          {row.department || 'Unassigned'}
                        </Box>
                        <Typography title={row.delivery_method || undefined} sx={{ fontSize: 12, mt: 0.4, fontWeight: weight, color: '#1B2838', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {row.delivery_method || '—'}
                        </Typography>
                      </TableCell>
                      <TableCell><StackedStamp date={arrived.date} time={arrived.time} /></TableCell>
                      <TableCell>
                        {fresh ? (
                          <Box sx={{ textAlign: 'center' }}>n/a</Box>
                        ) : (
                          <StackedStamp date={retrieved.date} time={retrieved.time} missing="n/a" />
                        )}
                      </TableCell>
                      <TableCell><StackedStamp date={due.date} time={due.time} /></TableCell>
                      <TableCell data-testid="board-process">
                        <Box sx={{ whiteSpace: 'nowrap' }}>{row.status_label || 'LiveOrder'}</Box>
                        <Box sx={{ fontSize: 12, whiteSpace: 'nowrap' }}>{row.files_label || '0 / 0'}</Box>
                      </TableCell>
                    </TableRow>
                    );
                  }) : (
                    <TableRow>
                      <TableCell colSpan={6} sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
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
          </Box>
        </Box>

        <Box ref={detailRef} sx={{ gridColumn: { xs: '1', lg: '2' }, gridRow: { xs: 2, lg: 1 }, minWidth: 0 }}>
          {selectedRow ? (
            <BoardDetailPane
              row={selectedRow}
              refreshKey={refreshKey}
              timeZone={boardZone}
              canMove={canMove}
              onClose={() => {
                setSelectedId(null);
                setSelectedRow(null);
              }}
              onMove={(target) => setMoveTarget(target)}
            />
          ) : (
            <SelectTransferPrompt />
          )}
        </Box>

        <Box sx={{ gridColumn: '1 / -1', display: 'grid', gap: 2 }}>
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
                          {scan.to_department ? null : scan.location ? (
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

        <Box
          sx={{
            display: 'grid',
            gap: 2,
            alignContent: 'start',
            gridColumn: '1 / -1',
            gridTemplateColumns: { xs: '1fr', md: '1fr 1fr 1fr' },
          }}
        >
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
                    <Typography sx={{ fontSize: 13 }}>
                      {item.manual ? <Chip label="Manual" size="small" sx={{ mr: 0.75, height: 18 }} /> : null}
                      {item.summary}
                    </Typography>
                  )}
                  {!item.external_id && item.manual ? (
                    <Chip label="Manual" size="small" sx={{ mr: 0.75, height: 18 }} />
                  ) : null}
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
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
            <Typography sx={{ fontSize: 14, fontWeight: 700, color: brand.navy }}>Stat cards</Typography>
            <Switch
              checked={showStats}
              onChange={(event) => setShowStats(event.target.checked)}
              inputProps={{ 'aria-label': 'Show stat cards' }}
            />
          </Box>
          <TextField
            select
            size="small"
            label="Status"
            value={draftFilters.status}
            onChange={(event) => setDraftFilters((current) => ({ ...current, status: event.target.value }))}
          >
            <MenuItem value="">Any</MenuItem>
            <MenuItem value="open">Open</MenuItem>
            <MenuItem value="in-progress">In Production</MenuItem>
            <MenuItem value="on-hold">On hold</MenuItem>
            <MenuItem value="completed">Completed</MenuItem>
          </TextField>
          <TextField
            select
            size="small"
            label="Category"
            value={draftFilters.category}
            onChange={(event) => setDraftFilters((current) => ({ ...current, category: event.target.value }))}
          >
            <MenuItem value="">Any</MenuItem>
            {BOARD_CATEGORY_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
            ))}
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

      <MoveWorkOrderDialog
        open={Boolean(moveTarget)}
        workOrder={moveTarget}
        onClose={() => setMoveTarget(null)}
        onMoved={(message) => {
          setMoveNotice(message);
          requestBoardRefresh();
        }}
      />
      <Snackbar
        open={Boolean(moveNotice)}
        autoHideDuration={4000}
        onClose={() => setMoveNotice('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" onClose={() => setMoveNotice('')} data-testid="move-snackbar" sx={{ width: '100%' }}>
          {moveNotice}
        </Alert>
      </Snackbar>
    </Box>
  );
}
