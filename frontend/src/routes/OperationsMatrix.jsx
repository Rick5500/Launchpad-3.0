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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
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
  // Delivery completion dialog state
  const [deliveryDialogOpen, setDeliveryDialogOpen] = useState(false);
  const [deliveryDialogWO, setDeliveryDialogWO] = useState(null);
  const [markingDeliveryComplete, setMarkingDeliveryComplete] = useState(false);

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

  const handleDeliveryComplete = async (wo) => {
    setDeliveryDialogWO(wo);
    setDeliveryDialogOpen(true);
  };

  const handleConfirmDeliveryComplete = async () => {
    if (!deliveryDialogWO) return;

    setMarkingDeliveryComplete(true);
    try {
      const response = await authFetch(`/api/matrix/work-orders/${deliveryDialogWO.id}/delivery-complete`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        const errorData = await response.json();
        setError(errorData.error || 'Failed to mark delivery complete');
        setDeliveryDialogOpen(false);
        return;
      }

      setDeliveryDialogOpen(false);
      setDeliveryDialogWO(null);
      loadWorkOrders();
    } catch (err) {
      setError(err.message || 'Failed to mark delivery complete');
      setDeliveryDialogOpen(false);
    } finally {
      setMarkingDeliveryComplete(false);
    }
  };

  const handleCancelDeliveryDialog = () => {
    setDeliveryDialogOpen(false);
    setDeliveryDialogWO(null);
    setMarkingDeliveryComplete(false);
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
    normal: '#1f2a38',
    urgent: '#2a2416',
    overdue: '#2a1f1f',
  };

  const dueStatusBorders = {
    normal: '#334455',
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
    const isQCComplete = wo.qc_status === 'Complete';
    const deliveryStatus = wo.delivery_status || 'Pending';
    const deliveryMethod = wo.delivery_method === 'will_call' ? 'Will Call' : 'Delivery';
    
    const handleDeliveryClick = async (e) => {
      e.stopPropagation();
      if (!isQCComplete) {
        setError('Cannot mark delivery complete until QC is complete');
        return;
      }
      
      if (deliveryStatus === 'Complete') {
        setError('Delivery already marked as complete');
        return;
      }

      if (deliveryStatus === 'Ready') {
        handleDeliveryComplete(wo);
      }
    };

    // Determine colors and states based on delivery_status
    let bgColor = '#BDBDBD';
    let textColor = '#757575';
    let cursor = 'not-allowed';
    let opacity = 0.5;
    let displayText = `Pending ${deliveryMethod}`;

    if (deliveryStatus === 'Pending') {
      // Before QC complete - show pending state
      bgColor = '#BDBDBD';
      textColor = '#757575';
      cursor = 'not-allowed';
      opacity = 0.5;
      displayText = `Pending ${deliveryMethod}`;
    } else if (deliveryStatus === 'Ready') {
      // QC complete, delivery ready for marking
      bgColor = '#2196F3';
      textColor = '#FFFFFF';
      cursor = 'pointer';
      opacity = 1;
      displayText = `Ready for ${deliveryMethod}`;
    } else if (deliveryStatus === 'Complete') {
      // Delivery marked complete
      bgColor = '#66BB6A';
      textColor = '#FFFFFF';
      cursor = 'not-allowed';
      opacity = 1;
      displayText = `✓ ${deliveryMethod}`;
    }

    return (
      <TableCell 
        align="center" 
        onClick={handleDeliveryClick}
        sx={{ padding: '8px 4px' }}
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
            cursor,
            opacity,
            '&:hover': deliveryStatus === 'Ready' ? { backgroundColor: '#1976D2', opacity: 1 } : {},
          }}
        >
          {displayText}
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
            <TableContainer component={Paper} sx={{ overflowX: 'auto', backgroundColor: '#0f1822' }}>
              <Table stickyHeader size="small" sx={{ backgroundColor: '#0f1822' }}>
                <TableHead>
                  <TableRow sx={{ backgroundColor: '#1f2a38' }}>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '100px', color: '#ccc', backgroundColor: '#1f2a38' }}>Work Order</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '120px', color: '#ccc', backgroundColor: '#1f2a38' }}>Customer</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '140px', color: '#ccc', backgroundColor: '#1f2a38' }}>Due Date & Time</TableCell>
                    {displayDepartments.map(dept => (
                      <TableCell key={dept.id} sx={{ fontWeight: 'bold', minWidth: '100px', color: '#ccc', backgroundColor: '#1f2a38' }}>
                        {dept.name}
                      </TableCell>
                    ))}
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '80px', color: '#ccc', backgroundColor: '#1f2a38' }}>QC</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '100px', color: '#ccc', backgroundColor: '#1f2a38' }}>Delivery / Will Call</TableCell>
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
                          '&:hover': { backgroundColor: '#334455' },
                        }}
                      >
                        <TableCell sx={{ fontWeight: 500, color: '#eee' }}>
                          {wo.external_id || `#${wo.id}`}
                        </TableCell>
                        <TableCell sx={{ color: '#ccc' }}>{wo.customer_name || '—'}</TableCell>
                        <TableCell sx={{ color: '#ccc' }}>{formatDate(wo.due_date)}</TableCell>
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

      <Dialog
        open={deliveryDialogOpen}
        onClose={handleCancelDeliveryDialog}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 'bold' }}>
          Mark Delivery Complete
        </DialogTitle>
        <DialogContent sx={{ mt: 2 }}>
          {deliveryDialogWO && (
            <Box>
              <Box sx={{ mb: 2 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                  <span style={{ fontWeight: 'bold' }}>Work Order:</span>
                  <span>#{deliveryDialogWO.external_id || deliveryDialogWO.id}</span>
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                  <span style={{ fontWeight: 'bold' }}>Customer:</span>
                  <span>{deliveryDialogWO.customer_name || '—'}</span>
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 'bold' }}>Type:</span>
                  <span>
                    {deliveryDialogWO.delivery_method === 'will_call' ? 'Will Call' : 'Delivery'}
                  </span>
                </Box>
              </Box>
              <Box sx={{ p: 1.5, backgroundColor: '#f5f5f5', borderRadius: 1, color: '#333' }}>
                Mark this {deliveryDialogWO.delivery_method === 'will_call' ? 'will call' : 'delivery'} as complete? 
                This will move the work order to the Completed tab.
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button
            onClick={handleCancelDeliveryDialog}
            disabled={markingDeliveryComplete}
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirmDeliveryComplete}
            variant="contained"
            color="success"
            disabled={markingDeliveryComplete}
          >
            {markingDeliveryComplete ? 'Marking Complete...' : 'Mark Complete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
