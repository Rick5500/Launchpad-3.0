import React, { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  CardHeader,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Menu,
  MenuItem,
  Tabs,
  Tab,
  Alert,
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { authFetch } from '../api';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';

// Status colors consistent across the application
const statusColors = {
  'Not Required': '#BDBDBD',
  'Waiting': '#42A5F5',
  'Proof': '#FDD835',
  'In Progress': '#1976D2',
  'On Hold': '#FB8C00',
  'Complete': '#66BB6A',
  'Ready for QC': '#2E7D32',
  'In QC': '#1976D2',
};

const statusTextColors = {
  'Not Required': '#757575',
  'Waiting': '#FFFFFF',
  'Proof': '#000000',
  'In Progress': '#FFFFFF',
  'On Hold': '#FFFFFF',
  'Complete': '#FFFFFF',
  'Ready for QC': '#FFFFFF',
  'In QC': '#FFFFFF',
};

const qcStatuses = ['Not Required', 'Waiting', 'Ready for QC', 'In QC', 'On Hold', 'Complete'];
const depthStatuses = ['Not Required', 'Waiting', 'Proof', 'In Progress', 'On Hold', 'Complete'];

export default function OperationsMatrix() {
  const navigate = useNavigate();
  const [workOrders, setWorkOrders] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [anchorEl, setAnchorEl] = useState(null);
  const [selectedWO, setSelectedWO] = useState(null);
  const [selectedDept, setSelectedDept] = useState(null);

  // Fetch departments on mount
  useEffect(() => {
    authFetch('/api/departments')
      .then(res => {
        if (!res.ok) throw new Error('Failed to load departments');
        return res.json();
      })
      .then(data => {
        setDepartments(data || []);
      })
      .catch(err => {
        console.error('Failed to load departments:', err);
        setDepartments([]);
      });
  }, []);

  const loadWorkOrders = () => {
    setLoading(true);
    authFetch(`/api/matrix/work-orders?filter=${filter}`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load work orders');
        return res.json();
      })
      .then(data => {
        setWorkOrders(data.work_orders || []);
        setError('');
      })
      .catch(err => {
        setError(err.message || 'Failed to load work orders');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadWorkOrders();
  }, [filter]);

  const handleStatusClick = (event, wo, dept) => {
    event.stopPropagation();
    setSelectedWO(wo);
    setSelectedDept(dept);
    setAnchorEl(event.currentTarget);
  };

  const handleStatusChange = (newStatus) => {
    if (!selectedWO || !selectedDept) return;

    authFetch(`/api/matrix/work-orders/${selectedWO.id}/department/${selectedDept.id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
      .then(res => {
        if (!res.ok) throw new Error('Failed to update status');
        setAnchorEl(null);
        loadWorkOrders();
      })
      .catch(err => setError(err.message || 'Failed to update status'));
  };

  const handleQCStatusClick = (event, wo) => {
    event.stopPropagation();
    setSelectedWO(wo);
    setSelectedDept({ id: 'qc', name: 'QC' });
    setAnchorEl(event.currentTarget);
  };

  const handleQCStatusChange = (newStatus) => {
    if (!selectedWO) return;

    authFetch(`/api/matrix/work-orders/${selectedWO.id}/qc-status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
      .then(res => {
        if (!res.ok) throw new Error('Failed to update QC status');
        setAnchorEl(null);
        loadWorkOrders();
      })
      .catch(err => setError(err.message || 'Failed to update QC status'));
  };

  const handleRowClick = (workOrderId) => {
    navigate(`/workorders/${workOrderId}`);
  };

  const getDueStatus = (dueDate) => {
    if (!dueDate) return 'normal';
    const now = new Date();
    const due = new Date(dueDate);
    const msUntilDue = due.getTime() - now.getTime();
    const hoursUntilDue = msUntilDue / (1000 * 60 * 60);

    if (hoursUntilDue < 0) return 'overdue';
    if (hoursUntilDue < 1) return 'urgent';
    return 'normal';
  };

  const dueStatusColors = {
    normal: '#ffffff',
    urgent: '#FFF3E0',
    overdue: '#FFEBEE',
  };

  const dueStatusBorders = {
    normal: '#e0e0e0',
    urgent: '#FB8C00',
    overdue: '#EF5350',
  };

  const formatDate = (dateString) => {
    if (!dateString) return '—';
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const StatusCell = ({ wo, dept }) => {
    const status = wo.department_statuses?.[dept.name];
    const displayStatus = status?.status || 'Not Required';
    const bgColor = statusColors[displayStatus] || '#BDBDBD';
    const textColor = statusTextColors[displayStatus] || '#000000';

    return (
      <TableCell
        align="center"
        onClick={(e) => handleStatusClick(e, wo, dept)}
        sx={{
          padding: '8px 4px',
          cursor: 'pointer',
          '&:hover': { opacity: 0.8 },
        }}
      >
        <Box
          sx={{
            backgroundColor: bgColor,
            color: textColor,
            padding: '6px 12px',
            borderRadius: '4px',
            fontSize: '0.75rem',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {displayStatus}
        </Box>
      </TableCell>
    );
  };

  const QCCell = ({ wo }) => {
    const qcStatus = wo.qc_status || 'Not Required';
    const bgColor = statusColors[qcStatus] || '#BDBDBD';
    const textColor = statusTextColors[qcStatus] || '#000000';

    return (
      <TableCell
        align="center"
        onClick={(e) => handleQCStatusClick(e, wo)}
        sx={{
          padding: '8px 4px',
          cursor: 'pointer',
          '&:hover': { opacity: 0.8 },
        }}
      >
        <Box
          sx={{
            backgroundColor: bgColor,
            color: textColor,
            padding: '6px 12px',
            borderRadius: '4px',
            fontSize: '0.75rem',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {qcStatus}
        </Box>
      </TableCell>
    );
  };

  const DeliveryCell = ({ wo }) => {
    const deliveryStatus = wo.qc_status === 'Complete'
      ? (wo.delivery_type === 'will_call' ? 'Will Call' : 'Delivery')
      : '—';
    const bgColor = wo.qc_status === 'Complete' ? '#66BB6A' : '#BDBDBD';
    const textColor = '#FFFFFF';

    return (
      <TableCell align="center" sx={{ padding: '8px 4px' }}>
        <Box
          sx={{
            backgroundColor: bgColor,
            color: textColor,
            padding: '6px 12px',
            borderRadius: '4px',
            fontSize: '0.75rem',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {deliveryStatus}
        </Box>
      </TableCell>
    );
  };

  if (loading) {
    return <LoadingState message="Loading operations matrix..." />;
  }

  // Filter departments to exclude delivery and admin
  const displayDepartments = departments.filter(d => !['Delivery', 'Admin'].includes(d.name));

  return (
    <Box sx={{ p: 2 }}>
      <Card>
        <CardHeader
          title="Operations Matrix"
          subheader="Monitor all active work orders across departments"
        />
        <CardContent>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          <Tabs value={filter} onChange={(e, newFilter) => setFilter(newFilter)} sx={{ mb: 2 }}>
            <Tab label="All" value="all" />
            <Tab label="Graphics" value="graphics" />
            <Tab label="Small Format" value="small-format" />
            <Tab label="Reprographics" value="reprographics" />
            <Tab label="Scanning" value="scanning" />
            <Tab label="QC" value="qc" />
            <Tab label="Delivery" value="delivery" />
            <Tab label="Completed" value="completed" />
          </Tabs>

          {workOrders.length === 0 ? (
            <Alert severity="info">No work orders to display</Alert>
          ) : (
            <TableContainer component={Paper} sx={{ overflowX: 'auto' }}>
              <Table stickyHeader size="small">
                <TableHead>
                  <TableRow sx={{ backgroundColor: '#f5f5f5' }}>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '100px' }}>Work Order</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '120px' }}>Customer</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '140px' }}>Due Date & Time</TableCell>
                    {displayDepartments.map(dept => (
                      <TableCell key={dept.id} sx={{ fontWeight: 'bold', minWidth: '100px' }}>
                        {dept.name}
                      </TableCell>
                    ))}
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '80px' }}>QC</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '100px' }}>Delivery</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {workOrders.map((wo) => {
                    const dueStatus = getDueStatus(wo.due_date);
                    return (
                      <TableRow
                        key={wo.id}
                        onClick={() => handleRowClick(wo.id)}
                        sx={{
                          cursor: 'pointer',
                          backgroundColor: dueStatusColors[dueStatus],
                          borderLeft: `4px solid ${dueStatusBorders[dueStatus]}`,
                          '&:hover': { backgroundColor: 'rgba(0, 0, 0, 0.04)' },
                        }}
                      >
                        <TableCell sx={{ fontWeight: 500 }}>
                          {wo.external_id || `#${wo.id}`}
                        </TableCell>
                        <TableCell>{wo.customer_name || '—'}</TableCell>
                        <TableCell>{formatDate(wo.due_date)}</TableCell>
                        {displayDepartments.map(dept => (
                          <StatusCell key={`${wo.id}-${dept.id}`} wo={wo} dept={dept} />
                        ))}
                        <QCCell wo={wo} />
                        <DeliveryCell wo={wo} />
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
      >
        {selectedDept?.id === 'qc'
          ? qcStatuses.map((status) => (
              <MenuItem key={status} onClick={() => handleQCStatusChange(status)}>
                {status}
              </MenuItem>
            ))
          : depthStatuses.map((status) => (
              <MenuItem key={status} onClick={() => handleStatusChange(status)}>
                {status}
              </MenuItem>
            ))}
      </Menu>
    </Box>
  );
}
