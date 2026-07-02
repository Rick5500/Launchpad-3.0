# Navigation Modules - Complete Code Structure Analysis

**Analysis Date:** 2026-06-29  
**Scope:** Work Orders, Operations Matrix, Delivery modules across backend routes and frontend components

---

## 📋 QUICK REFERENCE

| Module | Backend Routes | Frontend Components | Key Tables |
|--------|----------------|--------------------|-----------|
| **Work Orders** | `backend/routes/workOrders.js` | `WorkOrdersList.jsx`, `WorkOrderDetail.jsx`, `WorkOrderForm.jsx` | `work_orders`, `work_order_line_items`, `work_order_department_status`, `work_order_matrix_state` |
| **Operations Matrix** | `backend/routes/matrix.js` | `OperationsMatrix.jsx` | `work_order_department_status`, `work_order_matrix_state` |
| **Delivery** | `backend/routes/delivery.js` | `Delivery.jsx` | `work_orders`, `work_order_matrix_state` |
| **Dashboard** | `backend/routes/dashboard.js` | `HomeDashboard.jsx` | All tables (summary queries) |

---

## 1. BACKEND ENDPOINTS DETAILED MAPPING

### 1.1 Work Orders Routes (`backend/routes/workOrders.js`)

#### Endpoint: `GET /api/workorders`
- **Method:** GET
- **Auth:** Required (`auth.requireAuth`)
- **Purpose:** List all active work orders with department statuses
- **Response Status:** 200 on success, 500 on error

**Fields Returned:**
```javascript
[
  id,
  external_id,
  description,
  quantity,
  status,
  priority,
  due_date,
  delivery_method,           // ✓ From work_orders table
  requested_delivery_time,
  created_at,
  updated_at,
  customer_name,             // Joined from users.display_name
  customer_username,         // Joined from users.username
  qc_status,                 // From work_order_matrix_state.qc_status
  delivery_type,             // From work_order_matrix_state.delivery_type (delivery or will_call)
  is_completed,              // From work_order_matrix_state.is_completed
  department_statuses: [     // Array of department objects
    {
      id: department_id,
      name: department_name,
      color: hex_color,
      status: 'Not Required'|'Waiting'|'Proof'|'In Progress'|'On Hold'|'Complete'
    }
  ]
]
```

**Query Details:**
- Filters: `WHERE wo.status = 'open'`
- Sorts: `ORDER BY wo.due_date ASC, wo.created_at DESC`
- Left joins: `users` (customer info), `work_order_matrix_state` (QC/delivery data)
- Secondary query fetches department statuses for all work orders

---

#### Endpoint: `GET /api/workorders/:id`
- **Method:** GET
- **Auth:** Required
- **Purpose:** Get complete work order detail with all related data
- **Response Status:** 200 on success, 404 if not found, 500 on error

**Fields Returned:**
```javascript
{
  // All fields from GET /api/workorders plus:
  stage_id,
  department,
  assigned_department_id,
  assigned_user_id,
  estimated_hours,
  actual_hours,
  specifications,
  start_date,
  production_line,
  routing_instructions,
  attachments,
  notes,
  
  // Nested objects fetched in parallel:
  line_items: [
    {
      id,
      work_order_id,
      product_id,
      product_name,
      description,
      quantity,
      notes,
      category_name,
      proof_required,
      qc_required,
      barcode_required,
      default_turnaround_hours,
      required_departments: [
        {
          id: dept_id,
          department_id,
          department_name,
          color,
          icon
        }
      ]
    }
  ],
  
  department_statuses: [
    {
      id,
      work_order_id,
      department_id,
      status: 'Not Required'|'Waiting'|'Proof'|'In Progress'|'On Hold'|'Complete',
      updated_at,
      created_at,
      department_name,
      color,
      icon,
      sort_order
    }
  ],
  
  matrix_state: {
    qc_status: 'Not Required'|'Waiting'|'Ready for QC'|'In QC'|'On Hold'|'Complete',
    delivery_type: null|'delivery'|'will_call',  // ✓ SECOND location for delivery type
    is_completed: 0|1,
    updated_at,
    created_at
  },
  
  latest_barcode: {
    scanned_value,
    event_time,
    location
  }
}
```

**Query Details:**
- Fetches 4 datasets in parallel:
  1. Main work order + customer info
  2. Line items with required departments
  3. Department statuses from `work_order_department_status`
  4. QC/matrix state from `work_order_matrix_state`
  5. Latest barcode from `barcode_events`

---

#### Endpoint: `POST /api/workorders`
- **Method:** POST
- **Auth:** Required
- **Purpose:** Create new work order
- **Request Body:** All work order fields + optional `line_items` array
- **Response Status:** 201 on success, 400 if validation fails, 500 on error

**Required Fields (Validation):**
- `customer_id` (integer > 0)
- `description` (non-empty string)
- `quantity` (number ≥ 0)
- `status` (string)
- `department` (string)

**Optional Fields:**
- `external_id`, `stage_id`, `priority`, `assigned_department_id`, `assigned_user_id`
- `estimated_hours`, `actual_hours`, `specifications`, `start_date`, `due_date`
- `production_line`, `routing_instructions`, `attachments`, `notes`
- `delivery_method` (default: 'delivery')
- `requested_delivery_time`
- `line_items` (array of product line items)

**Fields Written to Database:**
```javascript
{
  external_id,
  customer_id,
  description,
  quantity,
  status,
  department,
  stage_id,
  priority,
  assigned_department_id,
  assigned_user_id,
  estimated_hours,
  actual_hours,
  specifications,
  start_date,
  due_date,
  production_line,
  routing_instructions,
  attachments,
  notes,
  delivery_method,         // ✓ Stored in work_orders
  requested_delivery_time,
  created_at,
  updated_at
}
```

**Post-Creation Actions:**
- If `line_items` array provided:
  - Inserts into `work_order_line_items` table
  - Calls `syncDepartmentStatusFromLineItems()` to auto-populate `work_order_department_status`

**Response:** Returns created work order with all fields + line_items

---

#### Endpoint: `PUT /api/workorders/:id`
- **Method:** PUT
- **Auth:** Required
- **Purpose:** Update existing work order
- **Request Body:** Same as POST
- **Response Status:** 200 on success, 404 if not found, 400 if validation fails, 500 on error

**Update Behavior:**
- Same validation as POST
- Updates all fields including `delivery_method`
- If `line_items` provided: deletes old items and inserts new ones
- Triggers `syncDepartmentStatusFromLineItems()` if line items updated

**Response:** Returns updated work order with all fields

---

#### Endpoint: `PUT /api/workorders/:id/stage`
- **Method:** PUT
- **Auth:** Required
- **Purpose:** Update work order stage only
- **Request Body:** `{ "stage_id": integer or null }`
- **Response Status:** 200 on success, 404 if not found, 500 on error
- **Response:** `{ success: true, id, stage_id }`

---

#### Endpoint: `PUT /api/workorders/:id/priority`
- **Method:** PUT
- **Auth:** Required
- **Purpose:** Update work order priority only
- **Request Body:** `{ "priority": "Low"|"Normal"|"High"|"Rush" }`
- **Response Status:** 200 on success, 400 if invalid priority, 404 if not found, 500 on error
- **Response:** `{ success: true, id, priority }`

---

#### Endpoint: `GET /api/workorders/:id/events`
- **Method:** GET
- **Auth:** Required
- **Purpose:** Get all work order events (audit trail)
- **Response Status:** 200 on success, 500 on error

**Fields Returned:**
```javascript
[
  {
    id,
    work_order_id,
    event_type: 'stage_change'|'department_change'|'barcode_scan'|'stage_change+department_change'|'note',
    from_stage_id,
    to_stage_id,
    from_department_id,
    to_department_id,
    note,
    created_at,
    from_stage_name,
    to_stage_name,
    from_department_name,
    to_department_name
  }
]
```

**Query Details:**
- Filters: `WHERE work_order_id = ?`
- Sorts: `ORDER BY created_at DESC`
- Joins: `production_stages`, `departments`

---

#### Endpoint: `POST /api/workorders/:id/events`
- **Method:** POST
- **Auth:** Required
- **Purpose:** Create new work order event
- **Request Body:** `{ "event_type", "from_stage_id", "to_stage_id", "from_department_id", "to_department_id", "note" }`
- **Required Fields:** `event_type` only
- **Response Status:** 201 on success, 400 if missing event_type, 500 on error
- **Response:** The created event object (same structure as GET response)

---

### 1.2 Operations Matrix Routes (`backend/routes/matrix.js`)

#### Endpoint: `GET /api/matrix/work-orders`
- **Method:** GET
- **Auth:** Required
- **Purpose:** Get work orders for operations matrix with department status filters
- **Query Parameters:** `?filter=all|graphics|small-format|reprographics|scanning|qc|delivery|completed`
- **Response Status:** 200 on success, 500 on error

**Fields Returned:**
```javascript
{
  work_orders: [
    {
      id,
      external_id,
      description,
      quantity,
      status,
      due_date,
      priority,
      customer_name,
      qc_status,
      delivery_type,         // ✓ Included in matrix response
      is_completed,
      department_statuses: {
        "Graphics": { status, color, icon },
        "Small Format": { status, color, icon },
        "Reprographics": { status, color, icon },
        "Scanning": { status, color, icon },
        ...
      }
    }
  ]
}
```

**Filter Logic (WHERE clause applied):**

| Filter | Condition | Source |
|--------|-----------|--------|
| `all` | `wo.status = 'open'` | active work orders |
| `graphics` | EXISTS dept status where dept.name='Graphics' AND status!='Not Required' | `work_order_department_status` |
| `small-format` | EXISTS dept status where dept.name='Small Format' AND status!='Not Required' | `work_order_department_status` |
| `reprographics` | EXISTS dept status where dept.name='Reprographics' AND status!='Not Required' | `work_order_department_status` |
| `scanning` | EXISTS dept status where dept.name='Scanning' AND status!='Not Required' | `work_order_department_status` |
| `qc` | `ms.qc_status IN ('Ready for QC', 'In QC', 'On Hold')` | `work_order_matrix_state.qc_status` |
| `delivery` | `ms.qc_status = 'Complete' AND ms.delivery_type IN ('delivery', 'will_call')` | `work_order_matrix_state` |
| `completed` | `ms.is_completed = 1` | `work_order_matrix_state.is_completed` |

**Query Details:**
- Main table: `work_orders` (aliased as `wo`)
- Joins: `users` (customer), `work_order_matrix_state` (matrix state)
- Secondary query fetches department statuses and groups by name
- Sorts: `ORDER BY wo.due_date ASC, wo.id ASC`
- Limit: 500 rows

---

### 1.3 Delivery Routes (`backend/routes/delivery.js`)

#### Endpoint: `GET /api/delivery`
- **Method:** GET
- **Auth:** Required
- **Purpose:** Get all deliveries ready for processing
- **Response Status:** 200 on success, 500 on error

**Fields Returned:**
```javascript
[
  {
    id,
    external_id,
    description,
    due_date,
    requested_delivery_time,  // ✓ From work_orders
    delivery_method,          // ✓ From work_orders (not used in frontend currently)
    customer_name,
    customer_username,
    qc_status,                // From work_order_matrix_state
    delivery_type,            // ✓ From work_order_matrix_state
    products: [
      { name, quantity }      // From work_order_line_items joined with products
    ]
  }
]
```

**Query Details:**
- Filter: `WHERE wo.status = 'open' AND ms.qc_status = 'Complete'`
- Sorts: `ORDER BY COALESCE(wo.requested_delivery_time, wo.due_date) ASC`
- Limit: 50 rows
- Secondary query fetches line items for each work order

---

#### Endpoint: `GET /api/delivery/upcoming`
- **Method:** GET
- **Auth:** Required
- **Purpose:** Get upcoming deliveries with optional type filtering
- **Query Parameters:** `?type=both|delivery|will_call` (default: 'both')
- **Response Status:** 200 on success, 500 on error

**Filter Logic (WHERE clause):**

| Type | Condition |
|------|-----------|
| `both` | `ms.qc_status = 'Complete'` |
| `delivery` | `ms.qc_status = 'Complete' AND ms.delivery_type = 'delivery'` |
| `will_call` | `ms.qc_status = 'Complete' AND ms.delivery_type = 'will_call'` |

**Fields Returned:**
Same as `GET /api/delivery` endpoint

**Query Details:**
- Same join and sort as `GET /api/delivery`
- Limit: 50 rows
- No secondary product query (different from GET /api/delivery)

---

### 1.4 Dashboard Routes (`backend/routes/dashboard.js`)

#### Endpoint: `GET /api/dashboard`
- **Method:** GET
- **Auth:** Required
- **Purpose:** Get dashboard summary statistics
- **Response Status:** 200 on success, 500 on error

**Fields Returned:**
```javascript
{
  totalWorkOrders: integer,
  activeWorkOrders: integer,
  productionBoardItems: integer,
  customers: integer,
  pendingDeliveries: integer,
  departmentSummary: [
    {
      name: department_name,
      color: hex_color,
      count: integer
    }
  ],
  qcSummary: [
    {
      qc_status: 'Not Required'|'Waiting'|'Ready for QC'|'In QC'|'On Hold'|'Complete',
      count: integer
    }
  ]
}
```

**Query Details:**
- Multiple independent COUNT queries
- Department summary: counts from `work_order_department_status` where status != 'Not Required'
- QC summary: counts from `work_order_matrix_state` where qc_status != 'Not Required'
- Excludes 'Delivery' and 'Admin' departments from department summary

---

## 2. FRONTEND COMPONENTS DETAILED MAPPING

### 2.1 Work Orders List (`frontend/src/routes/WorkOrdersList.jsx`)

**API Calls:**
```javascript
GET /api/workorders
```

**Props/State:**
```javascript
workOrders: [...]           // Array from API
loading: boolean
error: string | null
```

**Displays:**
- Table with columns: WO #, Description, Customer, Department Status, QC Status, Delivery
- "New Work Order" button navigates to `/work-orders/new`
- Clicking row navigates to `/workorders/{id}`

**Field Usage:**
- `external_id` or `id` → WO # column
- `description` → Description column
- `customer_name` → Customer column
- `department_statuses` array → Department Status chips
- `qc_status` → QC Status column
- `delivery_type` → Delivery column (shows type)
- `delivery_method` → (Not displayed)

**Styling:**
- Dark theme colors: #0f1822 (container), #1f2a38 (header/rows)
- Text colors: #ccc (secondary), #eee (primary)
- Hover: #334455

---

### 2.2 Operations Matrix (`frontend/src/routes/OperationsMatrix.jsx`)

**API Calls:**
```javascript
GET /api/departments          // Load available departments
GET /api/matrix/work-orders?filter={filter}  // Filter by department/status
```

**Props/State:**
```javascript
workOrders: [...]             // Array from matrix API
departments: [...]            // Array from departments API
filter: 'all'|'graphics'|'small-format'|'reprographics'|'scanning'|'qc'|'delivery'|'completed'
loading: boolean
error: string
anchorEl: null | HTMLElement  // For context menu
selectedWO: Work Order | null // For status update
selectedDept: Department | null
```

**UI Elements:**
- Tabs for each filter option
- Table with columns: columns vary, shows work order data + department statuses
- Context menu for status changes (click on status chip)

**Field Usage:**
- `id`, `external_id` → Row identification
- `description` → Description display
- `customer_name` → Customer display
- `due_date` → Sort and display
- `qc_status` → Filter criteria (QC tab)
- `delivery_type` → Filter criteria (Delivery tab), display type
- `is_completed` → Filter criteria (Completed tab)
- `department_statuses` object → Status chips for each department

**Status Update Flow:**
1. Click status chip for specific department
2. Context menu shows available statuses
3. POST to (implied) status update endpoint
4. Reload work orders

**Styling:**
- Same dark theme as WorkOrdersList
- Status chips with colors based on status
- Due date urgency colors: #1f2a38 (normal), #2a2416 (urgent), #2a1f1f (overdue)

---

### 2.3 Delivery (`frontend/src/routes/Delivery.jsx`)

**API Calls:**
```javascript
GET /api/delivery/upcoming              // No filter (type=both)
GET /api/delivery/upcoming?type=delivery
GET /api/delivery/upcoming?type=will_call
```

**Props/State:**
```javascript
deliveries: [...]             // Array from delivery API
filter: 'both'|'delivery'|'will_call'
loading: boolean
error: string
```

**UI Elements:**
- Tabs for filtering: All, Delivery, Will Call
- Table with columns: Work Order, Customer, Description, Delivery Date & Time, Requested Date & Time, Type, QC Status
- Clicking row navigates to `/workorders/{id}`

**Field Usage:**
- `external_id` or `id` → Work Order column
- `customer_name` → Customer column
- `description` → Description column
- `due_date` → Delivery Date & Time column
- `requested_delivery_time` → Requested Date & Time column
- `delivery_type` → Type column (shows "DELIVERY" or "WILL CALL")
- `qc_status` → QC Status column (always "Complete" for filtered results)
- `delivery_method` → (Not used in display)

**Styling:**
- Same dark theme colors
- Left border: #2196f3 (blue)
- Delivery type displayed in bold

---

### 2.4 Work Order Detail (`frontend/src/routes/WorkOrderDetail.jsx`)

**API Calls:**
```javascript
GET /api/workorders/:id       // Main work order detail
GET /api/workorders/:id/events  // Activity history timeline
```

**Props/State:**
```javascript
workOrder: {
  ...all fields from GET /api/workorders/:id...
}
events: [...]                 // Array from events API
selectedTab: 'Overview'|'Timeline'|'Specifications'|'Attachments'|'Activity History'|'Routing'|'Notes'
loading: boolean
error: string
eventsLoading: boolean
```

**Display Sections (Overview Tab):**
1. **Header Section:**
   - Work Order #, Customer Name
   - Status chips, Due Date, Priority

2. **Department Status Cards:**
   - Card for each department in `department_statuses`
   - Shows status, last updated, color-coded

3. **QC Status Section:**
   - Current QC status from `matrix_state.qc_status`
   - Delivery type from `matrix_state.delivery_type`
   - Is Completed flag from `matrix_state.is_completed`

4. **Product Line Items:**
   - Table of `line_items` with Product, Qty, Departments, Notes
   - Required departments shown as chips

5. **Timeline Tab:**
   - Visual timeline of events from `/api/workorders/:id/events`
   - Color-coded by event type

**Field Usage:**
- `external_id`, `id` → Work Order identification
- `customer_name` → Customer display
- `description` → Job description
- `quantity` → Quantity display
- `due_date`, `requested_delivery_time` → Date display
- `delivery_method` → (Not displayed in shown code)
- `delivery_type` → Delivery type display
- `qc_status` → QC status display
- `is_completed` → Completion status
- `department_statuses` → Department cards
- `line_items` → Product line items table
- `matrix_state` → QC and delivery state
- `latest_barcode` → Last barcode scan info

---

## 3. DELIVERY METHOD & DELIVERY TYPE HANDLING

### 3.1 Field Locations

**`delivery_method` (String field in `work_orders` table):**
- **Database:** `work_orders.delivery_method`
- **Type:** VARCHAR, default: 'delivery'
- **Backend Storage:** Stored directly from form input
- **Backend Retrieval:** 
  - Returned by `GET /api/workorders` ✓
  - Returned by `GET /api/workorders/:id` ✓
  - Returned by `GET /api/delivery` (included but not used)
  - Returned by `GET /api/delivery/upcoming` (included but not used)
  - NOT returned by `GET /api/matrix/work-orders` ✗

**`delivery_type` (String field in `work_order_matrix_state` table):**
- **Database:** `work_order_matrix_state.delivery_type`
- **Type:** VARCHAR, values: NULL | 'delivery' | 'will_call'
- **Set When:** Presumably when QC status changes to 'Complete'
- **Backend Retrieval:**
  - Returned by `GET /api/workorders` ✓
  - Returned by `GET /api/workorders/:id` (in `matrix_state.delivery_type`) ✓
  - Returned by `GET /api/matrix/work-orders` ✓
  - Returned by `GET /api/delivery` ✓
  - Returned by `GET /api/delivery/upcoming` ✓

### 3.2 Frontend Usage

**In WorkOrdersList:**
- Displays `delivery_type` in Delivery column if available
- Formatted: "DELIVERY" or "WILL CALL"

**In OperationsMatrix:**
- Uses `delivery_type` to filter rows when "Delivery" tab selected
- Condition: `delivery_type IN ('delivery', 'will_call')`

**In Delivery:**
- Filters by `delivery_type` with query parameter
- Displays `delivery_type` as "DELIVERY" or "WILL CALL" in Type column

**In WorkOrderDetail:**
- Shows `delivery_type` in QC Status section
- Shows `delivery_method` (not currently displayed)

### 3.3 Discrepancy Summary

⚠️ **CURRENT STATE:**
- Two fields exist: `delivery_method` (work_orders) and `delivery_type` (work_order_matrix_state)
- `delivery_method` is set at work order creation/update
- `delivery_type` is set separately (mechanism unknown - likely when QC completes)
- `delivery_type` is the source of truth for filtering/display in all UI modules

---

## 4. QC STATUS HANDLING

### 4.1 Field Location

**`qc_status` (String field in `work_order_matrix_state` table):**
- **Database:** `work_order_matrix_state.qc_status`
- **Type:** VARCHAR
- **Valid Values:** 'Not Required', 'Waiting', 'Ready for QC', 'In QC', 'On Hold', 'Complete'
- **Default:** 'Not Required'

### 4.2 How QC Status is Returned

**GET /api/workorders:**
```javascript
qc_status  // Direct field from work_order_matrix_state
```

**GET /api/workorders/:id:**
```javascript
matrix_state: {
  qc_status,
  delivery_type,
  is_completed,
  updated_at,
  created_at
}
```

**GET /api/matrix/work-orders:**
```javascript
qc_status  // Direct field from work_order_matrix_state
```

**GET /api/delivery and GET /api/delivery/upcoming:**
```javascript
qc_status  // Always 'Complete' for filtered results
```

### 4.3 Frontend Usage

**WorkOrdersList:**
- Displays `qc_status` in QC Status column

**OperationsMatrix:**
- Filters by `qc_status` when "QC" tab selected
- Condition: `qc_status IN ('Ready for QC', 'In QC', 'On Hold')`

**Delivery:**
- Uses `qc_status = 'Complete'` as filter (implicitly)
- Displays `qc_status` (always shows as 'Complete')

**WorkOrderDetail:**
- Displays `qc_status` in Overview tab
- Used to determine "Ready for QC" status (all depts complete)

---

## 5. DEPARTMENT STATUS HANDLING

### 5.1 Field Location

**`work_order_department_status` table:**
- **Columns:** id, work_order_id, department_id, status, updated_at, created_at
- **Unique Constraint:** (work_order_id, department_id)
- **Status Values:** 'Not Required', 'Waiting', 'Proof', 'In Progress', 'On Hold', 'Complete'
- **Default Status:** 'Not Required'

### 5.2 How Department Statuses are Returned

**GET /api/workorders:**
```javascript
department_statuses: [
  {
    id,
    name,
    color,
    status  // Current department status
  }
]
```

**GET /api/workorders/:id:**
```javascript
department_statuses: [
  {
    id,
    work_order_id,
    department_id,
    status,
    updated_at,
    created_at,
    department_name,
    color,
    icon,
    sort_order
  }
]
```

**GET /api/matrix/work-orders:**
```javascript
department_statuses: {
  "Graphics": { status, color, icon },
  "Small Format": { status, color, icon },
  ...
}
```

### 5.3 Automatic Syncing

**When line items are added/updated:**
- `syncDepartmentStatusFromLineItems()` is called
- Function queries `product_required_departments` for each product
- Creates entries in `work_order_department_status` for required departments
- Initial status: 'Not Required' (gets updated by operations matrix)

### 5.4 Frontend Usage

**WorkOrdersList:**
- Displays department status chips in Department Status column
- Shows each department's current status with color coding

**OperationsMatrix:**
- Displays department statuses in clickable chips
- Clicking opens context menu for status changes
- Color-coded by status value

**Delivery:**
- Does not display department statuses

**WorkOrderDetail:**
- Displays department status cards in Overview tab
- Shows status, last updated, color-coded

---

## 6. COMPLETE FILE PATH REFERENCE

### Backend Route Files
| Module | File Path | Endpoints |
|--------|-----------|-----------|
| Work Orders | `backend/routes/workOrders.js` | GET /, GET /:id, POST /, PUT /:id, PUT /:id/stage, PUT /:id/priority, GET /:id/events, POST /:id/events |
| Operations Matrix | `backend/routes/matrix.js` | GET /work-orders?filter=... |
| Delivery | `backend/routes/delivery.js` | GET /, GET /upcoming?type=... |
| Dashboard | `backend/routes/dashboard.js` | GET / |

### Frontend Component Files
| Module | File Path | Purpose |
|--------|-----------|---------|
| Work Orders List | `frontend/src/routes/WorkOrdersList.jsx` | Display all active work orders |
| Work Order Detail | `frontend/src/routes/WorkOrderDetail.jsx` | Display single work order with full details |
| Work Order Form | `frontend/src/routes/WorkOrderForm.jsx` | Create/edit work order (not analyzed in detail) |
| Operations Matrix | `frontend/src/routes/OperationsMatrix.jsx` | Department-based work order matrix with filtering |
| Delivery | `frontend/src/routes/Delivery.jsx` | Delivery queue management |
| Production Board | `frontend/src/routes/ProductionBoard.jsx` | (Not analyzed) |
| Dashboard | `frontend/src/routes/HomeDashboard.jsx` | (Not analyzed in detail) |

### Utility Files
| File Path | Purpose |
|-----------|---------|
| `frontend/src/api.js` | Provides `authFetch()` function for all API calls |
| `frontend/src/context/AuthContext.jsx` | Authentication context |
| `frontend/src/components/LoadingState.jsx` | Loading state component |
| `frontend/src/components/ErrorState.jsx` | Error state component |

### Database Schema
| File Path | Contents |
|-----------|----------|
| `database/schema.sql` | All table definitions |
| `backend/init_db.js` | Database initialization |
| `backend/db.js` | SQLite connection wrapper |

---

## 7. KEY INSIGHTS & OBSERVATIONS

### 7.1 Data Flow Summary

```
CREATE WORK ORDER
├─ POST /api/workorders
├─ Save: delivery_method (form input)
├─ Auto-create: work_order_department_status (from line item products)
└─ Auto-create: work_order_matrix_state (with defaults)

OPERATIONS MATRIX
├─ GET /api/matrix/work-orders?filter=X
├─ Returns: qc_status, delivery_type, department_statuses
├─ Filters on: QC status, delivery type, department statuses
└─ UPDATE: department_statuses (implied endpoint not shown)

QC COMPLETION
├─ Set: work_order_matrix_state.qc_status = 'Complete'
├─ Set: work_order_matrix_state.delivery_type = 'delivery'|'will_call' (mechanism unknown)
└─ Status in: work_order_matrix_state

DELIVERY WORKFLOW
├─ GET /api/delivery/upcoming?type=delivery|will_call
├─ Filters: qc_status='Complete' AND delivery_type matches
└─ Displays: work order with delivery info

WORK ORDER DETAIL
├─ GET /api/workorders/:id
├─ Returns: Full work order + line_items + department_statuses + matrix_state
└─ Displays: All sections including QC, Delivery, Departments
```

### 7.2 Two-Table Delivery Field Issue

⚠️ **Problem Identified:**
- `work_orders.delivery_method`: User-selected method at creation (delivery, will_call, pickup, etc.)
- `work_order_matrix_state.delivery_type`: Set when QC completes (delivery or will_call)
- Current code only uses `delivery_type` for filtering/display
- `delivery_method` is stored but not currently used in UI

✅ **Recommendation for Fix:**
- Clarify which field is source of truth
- Either: use `delivery_method` consistently, or
- Sync: set `delivery_type = delivery_method` when QC completes

### 7.3 Missing Status Update Endpoint

⚠️ **Observation:**
- OperationsMatrix component has code to click status chips
- Handler code reads `handleStatusClick()` but no endpoint shown
- Likely endpoint: `PUT /api/workorders/:id/department/:deptId/status` (not found)
- Needs verification in production code

### 7.4 QC Ready Determination

**Current Logic in WorkOrderDetail:**
```javascript
function isReadyForQC(workOrder) {
  if (!workOrder.department_statuses || workOrder.department_statuses.length === 0) {
    return false;  // No departments required
  }
  return workOrder.department_statuses.every(dept => 
    dept.status === 'Not Required' || dept.status === 'Complete'
  );
}
```

**This means:**
- Job is "Ready for QC" when ALL departments are either "Not Required" or "Complete"
- Does not check `qc_status` value (that's set separately)
- Used to show visual readiness indicator

### 7.5 API Call Pattern

All frontend components use:
```javascript
authFetch(url)
  .then(res => {
    if (!res.ok) throw new Error('Failed to load...');
    return res.json();
  })
  .then(data => setData(data))
  .catch(err => setError(err.message))
  .finally(() => setLoading(false));
```

- Consistent error handling
- Always checks response.ok
- Converts to JSON immediately

---

## 8. MATRIX FILTER VALIDATION TABLE

This table documents the exact filter logic implemented in `backend/routes/matrix.js`:

| Tab Label | Filter Value | Query Condition | Result Set |
|-----------|--------------|-----------------|-----------|
| All | `all` | `wo.status = 'open'` | All active work orders |
| Graphics | `graphics` | EXISTS (dept status = Graphics AND status != 'Not Required') | Work orders requiring Graphics dept |
| Small Format | `small-format` | EXISTS (dept status = Small Format AND status != 'Not Required') | Work orders requiring Small Format |
| Reprographics | `reprographics` | EXISTS (dept status = Reprographics AND status != 'Not Required') | Work orders requiring Reprographics |
| Scanning | `scanning` | EXISTS (dept status = Scanning AND status != 'Not Required') | Work orders requiring Scanning |
| QC | `qc` | `qc_status IN ('Ready for QC', 'In QC', 'On Hold')` | Work orders in QC pipeline |
| Delivery | `delivery` | `qc_status = 'Complete' AND delivery_type IN ('delivery', 'will_call')` | Work orders ready for delivery |
| Completed | `completed` | `is_completed = 1` | Completed work orders |

---

## 9. ENDPOINT RESPONSE SIZE CONSIDERATIONS

- **GET /api/workorders:** ~500 work orders (limited in matrix, but unlimited in list)
- **GET /api/workorders/:id:** Single work order + nested arrays (line_items, department_statuses, events)
- **GET /api/matrix/work-orders:** 500 work orders with flattened department_statuses object
- **GET /api/delivery/upcoming:** 50 deliveries max
- **GET /api/dashboard:** Single summary object with arrays

---

## 10. TESTING NOTES

**Test Data Available:**
- Work orders: #2, #3, 2026006-001 (from repo memory)
- Departments: Graphics, Small Format, Reprographics, Scanning, QC, Delivery (from filters)

**Known Test Results (from repo memory):**
- All tab: Shows 3 work orders
- Graphics tab: Shows 0 work orders
- Small Format tab: Shows 1 work order (#2 with "Proof" status)
- QC tab: Shows 0 work orders
- Delivery tab: Shows 0 work orders
- Completed tab: Shows 0 work orders

---

## 11. QUICK LOOKUP: WHERE EACH FIELD APPEARS

| Field | work_orders | matrix_state | Displayed In |
|-------|------------|--------------|--------------|
| `delivery_method` | ✓ Primary | ✗ | WorkOrdersList (not currently), WorkOrderDetail (not shown) |
| `delivery_type` | ✗ | ✓ Primary | WorkOrdersList, OperationsMatrix, Delivery, WorkOrderDetail |
| `qc_status` | ✗ | ✓ Primary | All components |
| `department_statuses` | ✗ | Indexed via wo_id | All components except Delivery |
| `is_completed` | ✗ | ✓ | OperationsMatrix (Completed filter), WorkOrderDetail |
| `line_items` | ✗ | Via query | WorkOrderDetail, Delivery (products) |

---

**End of Analysis Document**

Generated: 2026-06-29
