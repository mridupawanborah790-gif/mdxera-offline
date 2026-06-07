export type UserRole = 'owner' | 'admin' | 'manager' | 'purchase' | 'clerk' | 'viewer';

export interface NavItem {
    id: string;
    name: string;
    href: string;
    icon: any;
    roles: UserRole[];
    children?: NavItem[];
}

export interface ModuleConfig {
    visible: boolean;
    fields?: { [key: string]: boolean };
}

export interface RegionalSettings {
    dateFormat: 'DD-MM-YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD';
    timeFormat: '12H' | '24H';
    timezone: string;
    language: string;
    decimalNotation: '1,234.56' | '1.234,56';
}

export interface BusinessUserView {
    id: string;
    name: string;
    assigned: boolean;
}

export interface WorkCenter {
    id: string;
    name: string;
    views: BusinessUserView[];
}

export interface BusinessRole {
    id: string;
    organization_id: string;
    name: string;
    description: string;
    workCenters?: WorkCenter[];
    permissionsMatrix?: Record<string, PermissionSet>;
    isSystemRole?: boolean;
    is_active: boolean;
}

export type PermissionAction = 'view' | 'entry' | 'edit' | 'delete' | 'approve' | 'print' | 'export' | 'full';

export interface PermissionSet {
    view: boolean;
    entry: boolean;
    edit: boolean;
    delete: boolean;
    approve: boolean;
    print: boolean;
    export: boolean;
    full: boolean;
}

export interface SoDConflict {
    id: string;
    viewA: string;
    viewB: string;
    description: string;
    mitigation: string;
    severity: 'High' | 'Medium';
}

export interface OrganizationMember {
    id: string;
    technicalId?: string;
    email: string;
    name: string;
    role: UserRole;
    status: 'active' | 'invited' | 'suspended';
    employeeId?: string;
    department?: string;
    company?: string;
    manager?: string;
    validFrom?: string;
    validTo?: string;
    isLocked: boolean;
    passwordLocked: boolean;
    securityPolicy?: string;
    regionalSettings?: RegionalSettings;
    assignedRoles?: string[];
    workCenters?: WorkCenter[];
}

export interface InvoiceNumberConfig {
    fy?: string;
    prefix: string;
    startingNumber: number;
    endNumber?: number;
    paddingLength: number;
    resetRule?: 'financial-year';
    useFiscalYear: boolean;
    currentNumber: number;
    internalCurrentNumber?: number;
    activeMode?: 'external' | 'internal';
}

export type TaxCalculationBasis = 
    | '1-Tax Exclusive' 
    | '2-Tax After Disc' 
    | '3-Excise Merge' 
    | '4-Tax After Disc Amt' 
    | '5-Tax Before Disc' 
    | '6-Tax After Disc' 
    | '7-Item wise SC A/F' 
    | '8-Item wise SC B/F'
    | 'E-Excl.MRP' 
    | 'I-Incl.MRP' 
    | 'S-Excl.S/R' 
    | 'W-Incl.S/R';

export interface SlabRule {
    qty: number;
    value: number;
    type: 'flat' | 'percent' | 'free_qty';
}

export interface DiscountRule {
    id: string;
    name: string;
    type: 'flat' | 'percentage' | 'trade' | 'cash' | 'slab';
    level: DiscountLevel;
    value: number;
    calculationBase: DiscCalculationBase;
    enabled: boolean;
    shortcutKey: string;
    allowManualOverride: boolean;
    applyBeforeTax: boolean;
    maxLimit?: number;
    slabs?: SlabRule[];
    slabType?: 'single' | 'progressive' | 'per_unit' | 'buy_x_get_y';
    customerTypes?: ('regular' | 'retail')[];
    paymentConditionDays?: number;
    paymentModes?: string[];
}

export type DiscountLevel = 'line' | 'quantity' | 'invoice';
export type DiscountValueType = 'flat' | 'percentage';
export type DiscCalculationBase = 'mrp' | 'ptr' | 'selling_price' | 'net_amount' | 'total_amount';
export type SchemeDiscountCalculationBase = 'subtotal' | 'after_trade_discount' | 'ask_user';
export type TaxCalculationBaseOption = 'subtotal' | 'after_trade_discount' | 'after_all_discounts';
export type LineAmountCalculationMode = 'excluding_discount' | 'including_discount';


export interface EWayLoginSetupConfig {
    gstnUsername?: string;
    gstnPassword?: string;
    gstnPasswordEncrypted?: string;
    einvoiceUsername?: string;
    einvoicePassword?: string;
    einvoicePasswordEncrypted?: string;
    ewayLoginId?: string;
    ewayPassword?: string;
    ewayLoginIdEncrypted?: string;
    ewayPasswordEncrypted?: string;
    showCredentials?: boolean;
    uploadDirectlyToPortal?: boolean;
    credentialStatus?: 'Configured' | 'Invalid' | 'Missing';
    portalLoginStatus?: 'Verified' | 'Not Verified' | 'Failed';
    lastCheckedOn?: string;
    loginVerifiedOn?: string;
    lastError?: string;
}

export interface AppConfigurations {
    id?: string;
    organization_id: string;
    invoiceConfig?: InvoiceNumberConfig;
    nonGstInvoiceConfig?: InvoiceNumberConfig;
    purchaseOrderConfig?: InvoiceNumberConfig;
    purchaseConfig?: InvoiceNumberConfig;
    physicalInventoryConfig?: InvoiceNumberConfig;
    deliveryChallanConfig?: InvoiceNumberConfig;
    salesChallanConfig?: InvoiceNumberConfig;
    medicineMasterConfig?: InvoiceNumberConfig;
    masterShortcuts?: string[];
    masterShortcutOrder?: { [shortcutId: string]: number };
    sidebar?: {
        isSidebarCollapsed?: boolean;
        isSidebarHidden?: boolean;
    };
    displayOptions?: {
        showMultipleRates?: boolean;
        strictStock?: boolean;
        showPurchaseRateInPOS?: boolean;
        expiryThreshold?: number;
        defaultRateTier?: 'mrp' | 'rateA' | 'rateB' | 'rateC' | 'ptr';
        calculationMode?: 'standard' | '8';
        askCalculationOnBilling?: boolean;
        defaultTaxBasis?: TaxCalculationBasis;
        showBillDiscountOnPrint?: boolean;
        showItemWiseDiscountOnPrint?: boolean;
        enableNegativeStock?: boolean;
        printCopies?: number;
        schemeDiscountCalculationBase?: SchemeDiscountCalculationBase;
        taxCalculationBase?: TaxCalculationBaseOption;
        purchaseLineAmountCalculationMode?: LineAmountCalculationMode;
        posLineAmountCalculationMode?: LineAmountCalculationMode;
        pricingMode?: 'mrp' | 'rate';
        pharmacy_logo_url?: string;
        dashboard_logo_url?: string;
    };
    modules?: { [key: string]: ModuleConfig };
    discountRules?: DiscountRule[];
    gstSettings?: {
        periodicity: 'monthly' | 'quarterly';
        returnType: 'Sahaj' | 'Sugam' | 'Quarterly (Normal)';
    };
    ewayLoginSetup?: EWayLoginSetupConfig;
    fiscalYearConfig?: {
        fiscalYearStartDate?: string;
        fiscalYearEndDate?: string;
        currentFiscalYear?: string;
        autoFiscalYearDetection?: boolean;
        allowBackdatedEntry?: boolean;
        lockPreviousFiscalYear?: boolean;
        voucherNumberingMode?: 'reset' | 'continue';
    };
    _isDirty?: boolean;
}

export interface RegisteredPharmacy {
    id: string; 
    user_id: string; 
    organization_id: string; 
    email: string;
    role: UserRole;
    is_active: boolean;
    full_name: string; 
    pharmacy_name: string;
    manager_name: string;
    address: string;
    address_line2?: string;
    pincode?: string;
    district?: string;
    state?: string;
    mobile: string;
    gstin?: string;
    retailer_gstin?: string;
    drug_license?: string | null;
    dl_valid_to?: string | null;
    food_license?: string | null;
    pan_number?: string;
    bank_account_name?: string;
    bank_account_number?: string;
    bank_ifsc_code?: string;
    bank_upi_id?: string;
    authorized_signatory?: string; 
    pharmacy_logo_url?: string;
    dashboard_logo_url?: string;
    terms_and_conditions?: string;
    purchase_order_terms?: string;
    organization_type?: 'Retail' | 'Distributor';
    subscription_plan?: string;
    subscription_status?: string;
    subscription_id?: string;
    created_at?: string;
    updated_at?: string;
}

export interface InventoryItem {
    id: string;
    organization_id: string;
    user_id?: string;
    name: string;
    brand: string;
    category: string;
    manufacturer: string;
    stock: number;
    unitsPerPack: number;
    packType?: string;
    unitOfMeasurement?: string;
    packUnit?: string;
    baseUnit?: string;
    outer_pack?: string;
    units_per_outer_pack?: number;
    minStockLimit: number;
    batch: string;
    expiry: string;
    purchasePrice: number;
    ptr?: number;
    mrp: number;
    rateA?: number;
    rateB?: number;
    rateC?: number;
    gstPercent: number;
    hsnCode: string;
    composition?: string;
    barcode?: string;
    deal?: number;
    free?: number;
    supplierName?: string;
    rackNumber?: string;
    cost?: number;
    value?: number;
    code?: string;
    description?: string;
    purchaseDeal?: number;
    purchaseFree?: number;
    taxBasis?: TaxCalculationBasis; 
    is_active: boolean;
}

export interface BillItem {
    id: string;
    inventoryItemId: string;
    name: string;
    brand?: string;
    category?: string;
    mrp: number;
    oldMrp?: number;
    quantity: number;
    looseQuantity?: number;
    unit: 'pack' | 'loose';
    gstPercent: number;
    discountPercent: number;
    itemFlatDiscount: number;
    freeQuantity?: number;
    schemeQty?: number;
    schemeTotalQty?: number;
    schemeMode?: 'flat' | 'percent' | 'price_override' | 'free_qty' | 'qty_ratio';
    schemeValue?: number;
    schemeDiscountAmount?: number;
    schemeDiscountPercent?: number;
    schemeDisplayPercent?: number;
    schemeBaseRate?: number;
    schemeCalculationBasis?: 'before_discount' | 'after_discount';
    schemeFormat?: string;
    schemeRate?: number;
    amount?: number;
    finalAmount?: number;
    manufacturer?: string;
    batch?: string;
    expiry?: string;
    rate?: number;
    rateA?: number;
    rateB?: number;
    rateC?: number;
    ptr?: number;
    hsnCode?: string;
    unitOfMeasurement?: string;
    unitsPerPack?: number;
    baseUnit?: string;
    packUnit?: string;
    packType?: string;
    taxBasis?: TaxCalculationBasis;
    appliedDiscountId?: string;
    appliedDiscountValue?: number;
    appliedDiscountType?: 'flat' | 'percentage';
}

export interface Transaction {
    id: string;
    invoiceNumber?: string;
    organization_id: string;
    user_id?: string; 
    date: string;
    customerName: string;
    customerId?: string | null;
    customerPhone?: string;
    customerAddress?: string;
    referredBy?: string;
    doctorId?: string | null;
    items: BillItem[];
    total: number;
    itemCount: number | string;
    status: 'completed' | 'cancelled' | 'draft' | 'hold';
    paymentMode?: string;
    billType?: 'regular' | 'non-gst';
    subtotal: number;
    totalItemDiscount: number;
    totalGst: number;
    schemeDiscount: number;
    adjustment?: number;
    narration?: string;
    roundOff: number;
    amountReceived?: number;
    prescriptionImages?: string[] | string;
    hideRetailerOnBill?: boolean;
    prescriptionUrl?: string;
    createdAt?: string;
    eWayBillNo?: string;
    eWayBillDate?: string;
    billedById?: string;
    billedByName?: string;
    taxCalculationType?: TaxCalculationBasis;
    pricingMode?: 'mrp' | 'rate';
    linkedChallans?: string[];
    previousBalanceBeforeBill?: number;
    balanceAfterBill?: number;
    companyCodeId?: string;
    setOfBooksId?: string;
    sync_status?: 'synced' | 'pending' | 'failed';
}

export type DetailedBill = Transaction & { pharmacy: RegisteredPharmacy; customerDetails?: Customer; };

export interface PurchaseItem {
    id: string;
    name: string;
    brand: string;
    category: string;
    batch: string;
    expiry: string;
    quantity: number;
    looseQuantity: number;
    freeQuantity: number;
    purchasePrice: number;
    mrp: number;
    rateA?: number;
    rateB?: number;
    rateC?: number;
    ptr?: number;
    gstPercent: number;
    hsnCode: string;
    discountPercent: number;
    schemeDiscountPercent: number;
    schemeDiscountAmount: number;
    matchStatus?: 'matched' | 'unmatched' | 'pending';
    selectedUnit?: 'pack' | 'loose';
    packType?: string;
    unitsPerPack?: number;
    unitOfMeasurement?: string;
    manufacturer?: string;
    inventoryItemId?: string;
    materialCode?: string;
    oldMrp?: number;
    composition?: string;
    lineBaseAmount?: number;
    taxableValue?: number;
    gstAmount?: number;
    calculatedSchemeDiscount?: number;
    lineTotal?: number;
}

export interface Purchase {
    id: string;
    purchaseSerialId: string;
    organization_id: string;
    user_id?: string; 
    supplier: string;
    invoiceNumber: string;
    date: string;
    items: PurchaseItem[];
    totalAmount: number;
    subtotal: number;
    totalGst: number;
    totalItemDiscount: number;
    totalItemSchemeDiscount: number;
    schemeDiscount: number;
    roundOff: number;
    status: 'completed' | 'cancelled' | 'draft' | 'hold';
    referenceDocNumber?: string;
    idempotency_key?: string;
    eWayBillNo?: string;
    eWayBillDate?: string;
    linkedChallans?: string[];
    sourcePurchaseOrderId?: string;
    sourceReceiveMode?: PurchaseOrderReceiveMode | 'POST_RECEIVED_ENTRY' | 'ADJUST_RECEIVED_ENTRY';
    companyCodeId?: string;
    setOfBooksId?: string;
    cancelledAt?: string;
    cancelledBy?: string;
    cancellationReason?: string;
}

export enum DeliveryChallanStatus {
    OPEN = 'open',
    CONVERTED = 'converted',
    CANCELLED = 'cancelled'
}

export interface DeliveryChallan {
    id: string;
    challanSerialId: string;
    organization_id: string;
    user_id?: string;
    supplier: string;
    challanNumber: string;
    date: string;
    items: PurchaseItem[];
    totalAmount: number;
    subtotal: number;
    totalGst: number;
    status: DeliveryChallanStatus;
    remarks?: string;
}

export enum SalesChallanStatus {
    OPEN = 'open',
    CONVERTED = 'converted',
    CANCELLED = 'cancelled'
}

export interface SalesChallan {
    id: string;
    challanSerialId: string;
    organization_id: string;
    user_id?: string;
    customerName: string;
    customerId?: string | null;
    customerPhone?: string;
    customerAddress?: string;
    referredBy?: string;
    date: string;
    items: BillItem[];
    totalAmount: number;
    subtotal: number;
    totalGst: number;
    status: SalesChallanStatus;
    narration?: string;
    billCategory?: string;
    remarks?: string;
}

export enum PurchaseOrderStatus {
    ORDERED = 'ordered',
    PARTIALLY_RECEIVED = 'partially_received',
    RECEIVED = 'received',
    CANCELLED = 'cancelled'
}

export enum PurchaseOrderReceiveMode {
    POST_RECEIVED_ENTRY = 'POST_RECEIVED_ENTRY',
    ADJUST_RECEIVED_ENTRY = 'ADJUST_RECEIVED_ENTRY'
}

export interface PurchaseOrderReceiveLink {
    id: string;
    purchaseOrderId: string;
    poNumber: string;
    purchaseBillId: string;
    purchaseSystemId: string;
    receiveMode: PurchaseOrderReceiveMode;
    receivedQty: number;
    adjustedQty: number;
    adjustedAt: string;
    adjustedBy?: string;
}

export interface PurchaseOrderItem {
    id: string;
    inventoryItemId?: string;
    medicineId?: string;
    name: string;
    itemCode?: string;
    sku?: string;
    supplierItemName?: string;
    brand: string;
    quantity: number;
    freeQuantity: number;
    purchasePrice: number;
    estimatedRate?: number;
    discountPercent?: number;
    packType?: string;
    unitOfMeasurement?: string;
    manufacturer?: string;
    hsnCode?: string;
    mrp?: number;
    gstPercent?: number;
    lineAmount?: number;
    discountAmount?: number;
    gstAmount?: number;
    estimatedAmount?: number;
    expectedDeliveryDate?: string;
    notes?: string;
    expiry?: string;
    receivedQuantity?: number;
    pendingQuantity?: number;
}

export interface PurchaseOrder {
    id: string;
    serialId: string;
    organization_id: string;
    user_id?: string;
    date: string;
    distributorId: string;
    distributorName: string;
    senderEmail?: string;
    items: PurchaseOrderItem[];
    status: PurchaseOrderStatus;
    syncStatus?: 'pending' | 'synced' | 'failed';
    totalItems: number;
    totalAmount: number;
    remarks?: string;
    receiveLinks?: PurchaseOrderReceiveLink[];
    sourcePurchaseBillIds?: string[];
}

export interface TransactionLedgerItem {
    id: string;
    date: string;
    type: 'sale' | 'payment' | 'return' | 'purchase' | 'openingBalance';
    entryCategory?:
        | 'invoice_payment'
        | 'down_payment'
        | 'down_payment_adjustment'
        | 'invoice_payment_adjustment'
        | 'payment_cancellation'
        | 'down_payment_cancellation'
        | 'down_payment_adjustment_reversal'
        | 'invoice_payment_adjustment_reversal';
    description: string;
    debit: number;
    credit: number;
    balance: number;
    paymentMode?: string;
    bankAccountId?: string;
    bankName?: string;
    referenceInvoiceId?: string;
    referenceInvoiceNumber?: string;
    sourceDownPaymentId?: string;
    sourcePaymentId?: string;
    adjustedAmount?: number;
    journalEntryId?: string;
    journalEntryNumber?: string;
    status?: 'active' | 'cancelled';
    cancelledAt?: string;
    cancelledBy?: string;
    cancellationReason?: string;
    cancellationVoucherNumber?: string;
    reversedEntryId?: string;
}

export interface Supplier {
    id: string;
    organization_id: string;
    user_id?: string;
    name: string;
    contact_person?: string;
    category?: string;
    phone?: string;
    mobile?: string;
    email?: string;
    website?: string;
    address?: string;
    address_line1?: string;
    address_line2?: string;
    area?: string;
    city?: string;
    pincode?: string;
    district?: string;
    state?: string;
    country?: string;
    gst_number?: string;
    pan_number?: string;
    drug_license?: string;
    food_license?: string;
    opening_balance?: number;
    ledger: TransactionLedgerItem[];
    payment_details: {
        upi_id?: string;
        bank_name?: string;
        ifsc_code?: string;
        branch_name?: string;
        payment_terms?: string;
        account_number?: string;
    };
    is_active: boolean;
    is_blocked?: boolean;
    remarks?: string;
    supplier_group?: string;
    control_gl_id?: string;
    created_at?: string;
    updated_at?: string;
}

export type Distributor = Supplier;

export interface Customer {
    id: string;
    organization_id: string;
    user_id?: string;
    name: string;
    phone?: string;
    email?: string;
    address?: string;
    address_line1?: string;
    address_line2?: string;
    area?: string;
    city?: string;
    pincode?: string;
    district?: string;
    state?: string;
    country?: string;
    gstNumber?: string;
    drugLicense?: string;
    panNumber?: string;
    ledger: TransactionLedgerItem[];
    defaultDiscount?: number;
    customerType?: 'regular' | 'retail';
    is_active: boolean;
    is_blocked?: boolean;
    defaultRateTier?: 'none' | 'rateA' | 'rateB' | 'rateC';
    assignedStaffId?: string;
    assignedStaffName?: string;
    opening_balance?: number;
    customerGroup?: string;
    controlGlId?: string;
    enableCreditLimit?: boolean;
    creditLimit?: number;
    creditDays?: number;
    creditStatus?: 'active' | 'blocked';
    creditControlMode?: 'warning_only' | 'hard_block';
    allowOverride?: boolean;
    overrideApprovalRequired?: boolean;
}

export interface Medicine {
    id: string; 
    organization_id: string; 
    user_id?: string; 
    name: string;
    materialCode: string;
    composition?: string;
    pack?: string;
    barcode?: string;
    brand?: string;
    manufacturer?: string;
    marketer?: string;
    description?: string;
    gstRate?: number;
    hsnCode?: string;
    imei?: string;
    productDiscount?: number;
    mrp?: string; 
    rateA?: number;
    rateB?: number;
    rateC?: number;
    defaultDiscountPercent?: number;
    schemePercent?: number;
    schemeType?: 'after_discount' | 'before_discount';
    schemeCalculationBasis?: 'after_discount' | 'before_discount';
    schemeFormat?: string;
    schemeRate?: number;
    masterPriceMaintains?: MasterPriceMaintainRecord[];
    isPrescriptionRequired?: boolean;
    is_active: boolean;
    countryOfOrigin?: string;
    directions?: string;
    materialMasterType?: 'trading_goods' | 'finished_goods' | 'consumables' | 'service_material' | 'packaging';
    isInventorised?: boolean;
    isSalesEnabled?: boolean;
    isPurchaseEnabled?: boolean;
    isProductionEnabled?: boolean;
    isInternalIssueEnabled?: boolean;
    valuationMethod?: 'standard' | 'moving_average';
    standardPriceRate?: number;
    movingAverageRate?: number;
    created_at?: string;
    updated_at?: string;
}

export interface MasterPriceMaintainRecord {
    id: string;
    materialCode: string;
    materialName: string;
    mrp: number;
    rateA: number;
    rateB: number;
    rateC: number;
    defaultDiscountPercent: number;
    schemePercent: number;
    schemeType: 'after_discount' | 'before_discount';
    schemeCalculationBasis?: 'after_discount' | 'before_discount';
    schemeFormat?: string;
    schemeRate?: number;
    validFrom: string;
    validTo: string;
    status: 'active' | 'inactive';
    remarks?: string;
    lastUpdatedBy?: string;
    lastUpdatedOn?: string;
    auditTrail?: Array<{
        changedAt: string;
        changedBy?: string;
        sourceModule: 'Master Price Maintain' | 'Inventory' | 'Material Master Data';
        field: string;
        oldValue: string;
        newValue: string;
    }>;
}

export interface MrpChangeLogEntry {
    id: string;
    organization_id: string;
    materialCode: string;
    productName: string;
    oldMrp: number;
    newMrp: number;
    changedAt: string;
    changedById?: string;
    changedByName?: string;
    sourceScreen: 'Inventory' | 'Material Master';
}

export interface SupplierProductMap {
    id: string;
    organization_id: string;
    supplier_id: string;
    supplier_product_name: string;
    master_medicine_id: string;
    auto_apply?: boolean;
}

export type DistributorProductMap = SupplierProductMap;

export interface Category {
    id: string;
    organization_id: string;
    name: string;
    description?: string;
    is_active: boolean;
    imageUrl?: string;
}

export interface SubCategory {
    id: string;
    organization_id: string;
    name: string;
    categoryId: string;
    description?: string;
    is_active: boolean;
    imageUrl?: string;
}

export enum PromotionStatus {
    DRAFT = 'draft',
    ACTIVE = 'active',
    EXPIRED = 'expired'
}

export enum PromotionAppliesTo {
    CATEGORY = 'category',
    SUBCATEGORY = 'subcategory',
    PRODUCT = 'product'
}

export enum PromotionDiscountType {
    PERCENT = 'percent',
    FLAT = 'flat'
}

export interface Promotion {
    id: string;
    organization_id: string;
    name: string;
    slug: string;
    description?: string;
    startDate: string;
    endDate: string;
    status: PromotionStatus;
    priority: number;
    appliesTo: PromotionAppliesTo[];
    assignment: {
        categoryIds: string[];
        subCategoryIds: string[];
        productIds: string[];
    };
    discountType: PromotionDiscountType;
    discountValue: number;
    maxDiscountAmount?: number;
    isGstInclusive: boolean;
    channels: string[];
}

export interface SalesReturnItem extends BillItem {
    returnQuantity: number;
    reason: string;
}

export interface SalesReturn {
    id: string;
    organization_id: string;
    date: string;
    originalInvoiceId: string;
    originalInvoiceNumber?: string;
    customerName: string;
    customerId?: string | null;
    items: SalesReturnItem[];
    totalRefund: number;
    remarks?: string;
}

export interface PurchaseReturnItem {
    id: string;
    inventoryItemId?: string;
    name: string;
    brand: string;
    batch?: string;
    expiry?: string;
    purchasePrice: number;
    quantity?: number;
    looseQuantity?: number;
    returnQuantity: number;
    reason: string;
    unitsPerPack?: number;
    packType?: string;
}

export interface PurchaseReturn {
    id: string;
    organization_id: string;
    date: string;
    supplier: string;
    originalPurchaseInvoiceId: string;
    items: PurchaseReturnItem[];
    totalValue: number;
    remarks?: string;
}

export interface CustomerPriceListEntry {
    id: string;
    organization_id: string;
    customerId: string;
    inventoryItemId: string;
    price: number;
    discountPercent?: number;
    updatedAt: string;
}

export interface ChatMessage {
    role: 'user' | 'model';
    parts: { text: string }[];
}

export interface ExtractedPurchaseBill {
    importStatus?: string;
    extractedItemsCount?: number;
    supplierDetected?: boolean;
    supplier?: string;
    invoiceNumber?: string;
    date?: string;
    supplierGstNumber?: string;
    supplierPanNumber?: string;
    supplierPhone?: string;
    supplierAddress?: string;
    schemeDiscount?: number;
    items: Partial<PurchaseItem>[];
    error?: string;
}

export interface ExtractedSalesBill {
    id?: string;
    date?: string;
    customerName?: string;
    customerPhone?: string;
    referredBy?: string;
    doctorId?: string;
    items: Partial<BillItem>[];
    total?: number;
    paymentMode?: string;
    billType?: 'regular' | 'non-gst';
    error?: string;
}

export interface DoctorMaster {
    id: string;
    organization_id: string;
    doctorCode?: string;
    name: string;
    qualification?: string;
    specialization?: string;
    registrationNo?: string;
    mobile?: string;
    alternateContact?: string;
    email?: string;
    clinicName?: string;
    area?: string;
    city?: string;
    state?: string;
    pincode?: string;
    commissionPercent?: number;
    is_active?: boolean;
    notes?: string;
    createdAt?: string;
    updatedAt?: string;
}

export interface Notification {
    id: number;
    type: 'success' | 'error' | 'warning';
    message: string;
}

export interface PhysicalInventoryCountItem {
    inventoryItemId: string;
    name: string;
    brand: string;
    batch: string;
    expiry: string;
    systemStock: number;
    physicalCount: number;
    variance: number;
    cost: number;
    unitsPerPack?: number;
}

export enum PhysicalInventoryStatus {
    IN_PROGRESS = 'in_progress',
    COMPLETED = 'completed',
    CANCELLED = 'cancelled'
}

export interface PhysicalInventorySession {
    id: string;
    organization_id: string;
    user_id?: string;
    voucher_no?: string;
    status: PhysicalInventoryStatus;
    startDate: string;
    endDate?: string;
    reason?: string;
    items: PhysicalInventoryCountItem[];
    totalVarianceValue: number;
    performedById?: string;
    performedByName?: string;
}

export enum EWayBillStatus {
    GENERATED = 'Generated',
    CANCELLED = 'Cancelled',
    EXPIRED = 'Expired',
    REJECTED = 'Rejected'
}

export enum EWayBillSupplyType {
    OUTWARD = 'Outward',
    INWARD = 'Inward'
}

export enum EWayBillDocumentType {
    TAX_INVOICE = 'Tax Invoice',
    BILL_OF_SUPPLY = 'Bill of Supply',
    DELIVERY_CHALLAN = 'Delivery Challan',
    BILL_OF_ENTRY = 'Bill of Supply',
    OTHERS = 'Others'
}

export enum EWayBillSubSupplyType {
    SALES = 'Sales',
    PURCHASE = 'Purchase',
    JOB_WORK = 'Job Work',
    SKD_CKD = 'SKD/CKD',
    EXHIBITION_CONSIGNMENT = 'Exhibition/Consignment',
    LINE_SALES_RETURN = 'Line Sales Return',
    FOR_OWN_USE = 'For Own Use',
    OTHERS = 'Others'
}

export enum EWayBillTransportMode {
    ROAD = 'Road',
    RAIL = 'Rail',
    AIR = 'Air',
    SHIP = 'Ship'
}

export enum EWayBillVehicleType {
    REGULAR = 'Regular',
    OVER_DIMENSIONAL_CARGO = 'Over Dimensional Cargo'
}

export interface SubstituteProduct {
    brand_name: string;
    manufacturer: string;
    is_exact_match: boolean;
    notes?: string;
}

export interface SubstituteResult {
    SUMMARY: string;
    PRIMARY_PRODUCT: {
        brand_name: string;
        generic_name: string;
        strength: string;
        dosage_form: string;
        pack_info?: string;
        google_reference_url?: string;
    };
    SUBSTITUTES_LIST: SubstituteProduct[];
    RAW_SEARCH_REFERENCES?: string[];
    SAFETY_NOTE: string;
}

export interface ReturnsProps {
    currentUser: RegisteredPharmacy | null;
    transactions: Transaction[];
    inventory: InventoryItem[];
    salesReturns: SalesReturn[];
    purchaseReturns: PurchaseReturn[];
    purchases: Purchase[];
    onAddSalesReturn: (ret: SalesReturn) => Promise<void>;
    onAddPurchaseReturn: (ret: PurchaseReturn) => Promise<void>;
    addNotification: (message: string, type?: 'success' | 'error' | 'warning') => void;
    defaultTab: 'sales' | 'purchase';
    isFixedMode: boolean;
    prefillSalesInvoiceId?: string | null;
    prefillPurchaseInvoiceId?: string | null;
    onPrefillSalesInvoiceHandled?: () => void;
    onPrefillPurchaseInvoiceHandled?: () => void;
}

export interface EWayBill {
    id: string;
    organization_id: string;
    linkedTransactionId?: string;
    linkedPurchaseId?: string;
    eWayBillNo: string;
    eWayBillNo_str: string;
    eWayBillDate: string;
    validUntil: string;
    supplyType: EWayBillSupplyType;
    subSupplyType: EWayBillSubSupplyType;
    documentType: EWayBillDocumentType;
    documentNo: string;
    documentDate: string;
    fromGstin: string;
    fromTrdName: string;
    fromAddr1: string;
    fromAddr2?: string;
    fromPlace: string;
    fromPincode: number;
    fromStateCode: number;
    toGstin: string;
    toTrdName: string;
    toAddr1: string;
    toAddr2: string;
    toPlace: string;
    toPincode: number;
    toStateCode: number;
    transactionType: 'Regular' | 'Bill To Ship To' | 'Bill From Ship From' | 'Combination Of 2 & 3';
    otherValue?: number;
    totalValue: number;
    cgstValue?: number;
    sgstValue?: number;
    igstValue?: number;
    cessValue?: number;
    nonGstValue?: number;
    estimationDuration?: number;
    transporterId?: string;
    transporterName?: string;
    transportMode: EWayBillTransportMode;
    vehicleNo?: string;
    vehicleType?: EWayBillVehicleType;
    distance?: number;
    status: EWayBillStatus;
}

export interface FileInput {
    mimeType: string;
    data: string;
}

export interface MbcCardType {
    id: string;
    organization_id: string;
    type_name: string;
    type_code: string;
    description?: string;
    default_validity_value: number;
    default_validity_unit: 'days' | 'months' | 'years';
    default_card_value: number;
    template_id?: string;
    color_theme?: string;
    prefix: string;
    auto_numbering: boolean;
    allow_manual_value_edit: boolean;
    allow_renewal: boolean;
    allow_upgrade: boolean;
    benefits?: string;
    terms_conditions?: string;
    is_active: boolean;
    created_at?: string;
    updated_at?: string;
}

export interface MbcCardTemplate {
    id: string;
    organization_id: string;
    template_name: string;
    template_code: string;
    card_type_id?: string;
    width: number;
    height: number;
    orientation: string;
    background_image?: string;
    logo_image?: string;
    template_json?: any;
    is_active: boolean;
    created_at?: string;
    updated_at?: string;
}

export interface MbcCard {
    id: string;
    organization_id: string;
    card_number: string;
    customer_name: string;
    guardian_name?: string;
    date_of_birth?: string;
    gender?: string;
    address_line_1?: string;
    address_line_2?: string;
    city?: string;
    district?: string;
    state?: string;
    pin_code?: string;
    phone_number: string;
    alternate_phone?: string;
    email?: string;
    card_type_id: string;
    template_id?: string;
    issue_date: string;
    validity_from: string;
    validity_to: string;
    validity_period_text?: string;
    card_value: number;
    qr_value?: string;
    barcode_value?: string;
    remarks?: string;
    status: 'active' | 'inactive' | 'expired' | 'upcoming';
    photo_url?: string;
    whatsapp_number?: string;
    website_link?: string;
    office_location_text?: string;
    created_by?: string;
    created_at?: string;
    updated_at?: string;
}


export interface MbcCardValueHistory {
    id: string;
    organization_id?: string;
    card_id: string;
    card_number: string;
    customer_name?: string;
    previous_value?: number;
    added_value: number;
    new_value: number;
    added_by?: string;
    remarks?: string;
    created_at?: string;
}

export interface MbcCardHistory {
    id: string;
    organization_id: string;
    mbc_card_id: string;
    action_type: 'create' | 'update' | 'renew' | 'upgrade' | 'deactivate' | 'value_add';
    old_card_type_id?: string;
    new_card_type_id?: string;
    old_validity_to?: string;
    new_validity_to?: string;
    old_card_value?: number;
    new_card_value?: number;
    remarks?: string;
    action_by?: string;
    action_date?: string;
}

