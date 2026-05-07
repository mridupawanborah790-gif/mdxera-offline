import { AppConfigurations } from '../types';

export const getDefaultFiscalYearWindow = (date = new Date()) => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const startYear = month >= 4 ? year : year - 1;
  const start = `${startYear}-04-01`;
  const end = `${startYear + 1}-03-31`;
  return { start, end, label: `${startYear}` };
};

export const resolveFiscalYearConfig = (config?: AppConfigurations) => {
  const fallback = getDefaultFiscalYearWindow();
  const fy = config?.fiscalYearConfig;
  return {
    fiscalYearStartDate: fy?.fiscalYearStartDate || fallback.start,
    fiscalYearEndDate: fy?.fiscalYearEndDate || fallback.end,
    currentFiscalYear: fy?.currentFiscalYear || fallback.label,
    autoFiscalYearDetection: fy?.autoFiscalYearDetection ?? true,
    allowBackdatedEntry: fy?.allowBackdatedEntry ?? true,
    lockPreviousFiscalYear: fy?.lockPreviousFiscalYear ?? false,
    voucherNumberingMode: fy?.voucherNumberingMode || 'reset' as const,
  };
};

export const isDateInActiveFiscalYear = (inputDate: string, config?: AppConfigurations) => {
  const { fiscalYearStartDate, fiscalYearEndDate } = resolveFiscalYearConfig(config);
  if (!inputDate) return false;
  return inputDate >= fiscalYearStartDate && inputDate <= fiscalYearEndDate;
};
