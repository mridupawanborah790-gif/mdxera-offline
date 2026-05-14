import React, { useEffect, useMemo, useState } from 'react';
import Card from '../components/Card';
import { supabase } from '../services/supabaseClient';
import type { RegisteredPharmacy, MbcCard, MbcCardHistory, MbcCardTemplate, MbcCardType } from '../types';

export type MbcScreen =
  | 'mbcCardDashboard'
  | 'mbcCardList'
  | 'mbcGenerateCard'
  | 'mbcCardTypeMaster'
  | 'mbcCardTemplateMaster'
  | 'mbcCardPrintPreview'
  | 'mbcCardRenewalHistory';

interface Props {
  currentUser: RegisteredPharmacy;
  activeScreen: MbcScreen;
  onNavigate: (screen: MbcScreen) => void;
}

type ValidityUnit = 'days' | 'months' | 'years';

const EMPTY_TYPE: Partial<MbcCardType> = {
  type_name: '',
  type_code: '',
  description: '',
  default_validity_value: 1,
  default_validity_unit: 'years',
  default_card_value: 0,
  prefix: 'MBC',
  auto_numbering: true,
  allow_manual_value_edit: false,
  allow_renewal: true,
  allow_upgrade: true,
  benefits: '',
  terms_conditions: '',
  is_active: true,
};

const EMPTY_TEMPLATE: Partial<MbcCardTemplate> = {
  template_name: '',
  template_code: '',
  width: 86,
  height: 54,
  orientation: 'landscape',
  background_image: '',
  logo_image: '',
  template_json: {},
  is_active: true,
};

const EMPTY_CARD: Partial<MbcCard> = {
  customer_name: '',
  guardian_name: '',
  date_of_birth: '',
  gender: '',
  address_line_1: '',
  address_line_2: '',
  city: '',
  district: '',
  state: '',
  pin_code: '',
  phone_number: '',
  alternate_phone: '',
  email: '',
  validity_from: '',
  validity_to: '',
  validity_period_text: '',
  card_value: 0,
  remarks: '',
  status: 'active',
};

const addByUnit = (date: Date, value: number, unit: ValidityUnit) => {
  const next = new Date(date);
  if (unit === 'days') next.setDate(next.getDate() + value);
  if (unit === 'months') next.setMonth(next.getMonth() + value);
  if (unit === 'years') next.setFullYear(next.getFullYear() + value);
  return next;
};

const toDateInput = (date: Date) => date.toISOString().slice(0, 10);
const getValidityPeriodText = (fromDate: string, toDate: string) => {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const msPerDay = 1000 * 60 * 60 * 24;
  const dayDiff = Math.ceil((to.getTime() - from.getTime()) / msPerDay);
  return dayDiff > 0 ? `${dayDiff} day${dayDiff === 1 ? '' : 's'}` : '';
};

const getCardStatus = (card: MbcCard) => {
  if (card.status === 'inactive') return 'inactive';
  const today = new Date();
  const from = new Date(card.validity_from);
  const to = new Date(card.validity_to);
  if (from > today) return 'upcoming';
  if (to < today) return 'expired';
  return 'active';
};

const MbcCardManagement: React.FC<Props> = ({ currentUser, activeScreen, onNavigate }) => {
  const [loading, setLoading] = useState(false);
  const [cardTypes, setCardTypes] = useState<MbcCardType[]>([]);
  const [templates, setTemplates] = useState<MbcCardTemplate[]>([]);
  const [cards, setCards] = useState<MbcCard[]>([]);
  const [history, setHistory] = useState<MbcCardHistory[]>([]);

  const [typeForm, setTypeForm] = useState<Partial<MbcCardType>>(EMPTY_TYPE);
  const [templateForm, setTemplateForm] = useState<Partial<MbcCardTemplate>>(EMPTY_TEMPLATE);
  const [cardForm, setCardForm] = useState<Partial<MbcCard>>(EMPTY_CARD);

  const [selectedCardId, setSelectedCardId] = useState<string>('');
  const [renewMonths, setRenewMonths] = useState(12);
  const [upgradeTypeId, setUpgradeTypeId] = useState<string>('');
  const [historyRemarks, setHistoryRemarks] = useState('');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [cardTypeFilter, setCardTypeFilter] = useState('');

  const refreshAll = async () => {
    setLoading(true);
    try {
      const [typeRes, templateRes, cardsRes, historyRes] = await Promise.all([
        supabase.from('mbc_card_types').select('*').eq('organization_id', currentUser.organization_id).order('created_at', { ascending: false }),
        supabase.from('mbc_card_templates').select('*').eq('organization_id', currentUser.organization_id).order('created_at', { ascending: false }),
        supabase.from('mbc_cards').select('*').eq('organization_id', currentUser.organization_id).order('created_at', { ascending: false }),
        supabase.from('mbc_card_history').select('*').eq('organization_id', currentUser.organization_id).order('action_date', { ascending: false }),
      ]);
      if (typeRes.error) throw typeRes.error;
      if (templateRes.error) throw templateRes.error;
      if (cardsRes.error) throw cardsRes.error;
      if (historyRes.error) throw historyRes.error;
      setCardTypes(typeRes.data || []);
      setTemplates(templateRes.data || []);
      setCards(cardsRes.data || []);
      setHistory(historyRes.data || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshAll();
  }, [currentUser.organization_id]);

  const cardTypeMap = useMemo(() => new Map(cardTypes.map(ct => [ct.id, ct])), [cardTypes]);
  const templateMap = useMemo(() => new Map(templates.map(tp => [tp.id, tp])), [templates]);

  const filteredCards = useMemo(() => {
    return cards.filter(card => {
      const q = search.trim().toLowerCase();
      const status = getCardStatus(card);
      if (q) {
        const hay = [card.card_number, card.customer_name, card.phone_number, card.address_line_1, card.address_line_2, card.city].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (statusFilter && status !== statusFilter) return false;
      if (cardTypeFilter && card.card_type_id !== cardTypeFilter) return false;
      return true;
    });
  }, [cards, search, statusFilter, cardTypeFilter]);

  const generateCardNumber = (type?: MbcCardType) => {
    if (!type) return '';
    const prefix = type.prefix || 'MBC';
    const numbers = cards
      .filter(card => card.card_number.startsWith(prefix))
      .map(card => Number((card.card_number.match(/(\d+)$/)?.[1]) || 0));
    const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
    return `${prefix}${String(next).padStart(4, '0')}`;
  };

  const applyDefaultsFromType = (typeId: string) => {
    const cardType = cardTypeMap.get(typeId);
    if (!cardType) return;
    setCardForm(prev => ({
      ...prev,
      card_type_id: typeId,
      template_id: cardType.template_id || prev.template_id,
      card_value: cardType.default_card_value || 0,
      card_number: cardType.auto_numbering ? generateCardNumber(cardType) : prev.card_number,
    }));
  };

  const saveCardType = async () => {
    if (!typeForm.type_name?.trim() || !typeForm.type_code?.trim()) {
      alert('Card type name and code are required');
      return;
    }
    const payload = {
      ...typeForm,
      organization_id: currentUser.organization_id,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('mbc_card_types').upsert(payload);
    if (error) {
      alert(error.message);
      return;
    }
    setTypeForm(EMPTY_TYPE);
    refreshAll();
  };

  const saveTemplate = async () => {
    if (!templateForm.template_name?.trim() || !templateForm.template_code?.trim()) {
      alert('Template name and code are required');
      return;
    }
    const { error } = await supabase.from('mbc_card_templates').upsert({
      ...templateForm,
      organization_id: currentUser.organization_id,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      alert(error.message);
      return;
    }
    setTemplateForm(EMPTY_TEMPLATE);
    refreshAll();
  };

  const saveCard = async () => {
    const phone = String(cardForm.phone_number || '').trim();
    if (!cardForm.customer_name?.trim() || !phone || !cardForm.card_type_id || !cardForm.date_of_birth || !cardForm.validity_from || !cardForm.validity_to) {
      alert('Customer, phone, card type, DOB and validity dates are required');
      return;
    }
    if (!/^\d{10}$/.test(phone)) {
      alert('Phone number should contain exactly 10 digits');
      return;
    }
    const todayDate = toDateInput(new Date());
    if ((cardForm.date_of_birth || '') >= todayDate) {
      alert('DOB must be earlier than today');
      return;
    }
    if ((cardForm.validity_to || '') <= (cardForm.validity_from || '')) {
      alert('Validity To must be greater than Validity From');
      return;
    }
    const cardNumber = String(cardForm.card_number || '').trim();
    if (!cardNumber) {
      alert('Card number is required');
      return;
    }
    const duplicateNumber = cards.find(c => c.card_number === cardNumber && c.id !== cardForm.id);
    if (duplicateNumber) {
      alert('Duplicate card number not allowed');
      return;
    }
    const duplicateActive = cards.find(c => c.phone_number === phone && getCardStatus(c) === 'active' && c.id !== cardForm.id);
    if (duplicateActive && !window.confirm('Duplicate active card found for this phone/customer. Continue?')) {
      return;
    }

    const status = cardForm.status === 'inactive' ? 'inactive' : 'active';
    const now = new Date().toISOString();
    const payload = {
      ...cardForm,
      organization_id: currentUser.organization_id,
      phone_number: phone,
      issue_date: cardForm.validity_from,
      qr_value: cardForm.qr_value || `${window.location.origin}/mbc/${cardNumber}`,
      created_by: currentUser.full_name,
      status,
      validity_period_text: getValidityPeriodText(String(cardForm.validity_from), String(cardForm.validity_to)),
      updated_at: now,
      created_at: cardForm.created_at || now,
    };

    const { data, error } = await supabase.from('mbc_cards').upsert(payload).select('id').single();
    if (error) {
      alert(error.message);
      return;
    }

    await supabase.from('mbc_card_history').insert({
      organization_id: currentUser.organization_id,
      mbc_card_id: data.id,
      action_type: cardForm.id ? 'update' : 'create',
      new_card_type_id: payload.card_type_id,
      new_validity_to: payload.validity_to,
      new_card_value: payload.card_value,
      remarks: payload.remarks || '',
      action_by: currentUser.full_name,
      action_date: now,
    });

    setCardForm(EMPTY_CARD);
    refreshAll();
    onNavigate('mbcCardList');
  };

  const doRenewUpgrade = async (mode: 'renew' | 'upgrade') => {
    const card = cards.find(c => c.id === selectedCardId);
    if (!card) return;
    const oldType = card.card_type_id;
    const oldTo = card.validity_to;
    const oldValue = card.card_value;

    const newType = mode === 'upgrade' ? upgradeTypeId || card.card_type_id : card.card_type_id;
    const typeConfig = cardTypeMap.get(newType);
    const currentEnd = new Date(card.validity_to);
    const base = currentEnd > new Date() ? currentEnd : new Date();
    const nextTo = mode === 'renew'
      ? addByUnit(base, renewMonths, 'months')
      : addByUnit(new Date(), Number(typeConfig?.default_validity_value || 1), (typeConfig?.default_validity_unit || 'years') as ValidityUnit);

    const patch: Partial<MbcCard> = {
      card_type_id: newType,
      template_id: typeConfig?.template_id || card.template_id,
      validity_to: toDateInput(nextTo),
      card_value: mode === 'upgrade' ? Number(typeConfig?.default_card_value || card.card_value) : card.card_value,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from('mbc_cards').update(patch).eq('id', card.id);
    if (error) {
      alert(error.message);
      return;
    }

    await supabase.from('mbc_card_history').insert({
      organization_id: currentUser.organization_id,
      mbc_card_id: card.id,
      action_type: mode,
      old_card_type_id: oldType,
      new_card_type_id: patch.card_type_id,
      old_validity_to: oldTo,
      new_validity_to: patch.validity_to,
      old_card_value: oldValue,
      new_card_value: patch.card_value,
      remarks: historyRemarks,
      action_by: currentUser.full_name,
      action_date: new Date().toISOString(),
    });

    setHistoryRemarks('');
    refreshAll();
  };

  const printPreviewCard = cards.find(c => c.id === selectedCardId) || cards[0];
  const printType = printPreviewCard ? cardTypeMap.get(printPreviewCard.card_type_id) : undefined;
  const printTemplate = printPreviewCard ? templateMap.get(printPreviewCard.template_id || '') : undefined;

  const summary = useMemo(() => {
    const now = new Date();
    const soon = new Date();
    soon.setDate(soon.getDate() + 30);
    const statusCounts = cards.reduce<Record<string, number>>((acc, c) => {
      const s = getCardStatus(c);
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});
    return {
      total: cards.length,
      active: statusCounts.active || 0,
      expired: statusCounts.expired || 0,
      expiringSoon: cards.filter(c => new Date(c.validity_to) >= now && new Date(c.validity_to) <= soon).length,
      renewalDue: cards.filter(c => new Date(c.validity_to) <= soon).length,
      recent: cards.slice(0, 5).length,
      gold: cards.filter(c => (cardTypeMap.get(c.card_type_id)?.type_name || '').toLowerCase() === 'gold').length,
      silver: cards.filter(c => (cardTypeMap.get(c.card_type_id)?.type_name || '').toLowerCase() === 'silver').length,
    };
  }, [cards, cardTypeMap]);

  const renderTitle = () => {
    const map: Record<MbcScreen, string> = {
      mbcCardDashboard: 'MBC Card Dashboard',
      mbcCardList: 'MBC Card List',
      mbcGenerateCard: 'Generate MBC Card',
      mbcCardTypeMaster: 'MBC Card Type Master',
      mbcCardTemplateMaster: 'MBC Card Template Master',
      mbcCardPrintPreview: 'Print / Preview MBC Card',
      mbcCardRenewalHistory: 'MBC Card Renewal / Upgrade History',
    };
    return map[activeScreen];
  };

  const actionButtons = (
    <div className="flex gap-2 flex-wrap">
      <button className="px-2 py-1 bg-primary text-white text-[10px] font-black uppercase" onClick={() => onNavigate('mbcGenerateCard')}>New Card</button>
      <button className="px-2 py-1 bg-primary text-white text-[10px] font-black uppercase" onClick={() => onNavigate('mbcCardList')}>Card List</button>
      <button className="px-2 py-1 bg-primary text-white text-[10px] font-black uppercase" onClick={() => onNavigate('mbcCardTypeMaster')}>Card Type Master</button>
      <button className="px-2 py-1 bg-primary text-white text-[10px] font-black uppercase" onClick={() => onNavigate('mbcCardTemplateMaster')}>Template Master</button>
      <button className="px-2 py-1 bg-primary text-white text-[10px] font-black uppercase" onClick={() => onNavigate('mbcCardPrintPreview')}>Print Card</button>
      <button className="px-2 py-1 bg-primary text-white text-[10px] font-black uppercase" onClick={() => onNavigate('mbcCardRenewalHistory')}>Renew Card</button>
    </div>
  );

  return (
    <main className="flex-1 overflow-hidden flex flex-col page-fade-in bg-app-bg">
      <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
        <span className="text-[10px] font-black uppercase tracking-widest">Other Master → MBC Card → {renderTitle()}</span>
        <span className="text-[10px] font-black uppercase text-accent">{loading ? 'Loading...' : `Cards: ${cards.length}`}</span>
      </div>

      <div className="p-4 flex-1 overflow-auto custom-scrollbar space-y-3">
        {actionButtons}

        {activeScreen === 'mbcCardDashboard' && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {[
                ['Total Cards', summary.total],
                ['Active Cards', summary.active],
                ['Expired Cards', summary.expired],
                ['Expiring Soon', summary.expiringSoon],
                ['Gold Cards', summary.gold],
                ['Silver Cards', summary.silver],
                ['Renewal Due', summary.renewalDue],
                ['Recently Generated', summary.recent],
              ].map(([label, value]) => (
                <Card key={String(label)} className="p-3 border border-gray-300">
                  <div className="text-[10px] uppercase font-black text-gray-500">{label}</div>
                  <div className="text-2xl font-black text-primary">{value as number}</div>
                </Card>
              ))}
            </div>

            <Card className="p-3 border border-gray-300">
              <div className="text-xs font-black uppercase mb-2">MBC Reports</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px]">
                {['Card Register', 'Card Type Wise Report', 'Active Card Report', 'Expired Card Report', 'Expiring Soon Report', 'Customer Wise Card Report', 'Renewal History Report', 'Upgrade History Report'].map(name => (
                  <button
                    key={name}
                    onClick={() => {
                      const rows = name.includes('History')
                        ? history
                        : cards.filter(c => {
                            const status = getCardStatus(c);
                            if (name === 'Active Card Report') return status === 'active';
                            if (name === 'Expired Card Report') return status === 'expired';
                            if (name === 'Expiring Soon Report') {
                              const dt = new Date(c.validity_to);
                              const soon = new Date();
                              soon.setDate(soon.getDate() + 30);
                              return dt <= soon;
                            }
                            return true;
                          });
                      const text = JSON.stringify(rows, null, 2);
                      const blob = new Blob([text], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `${name.replace(/\s+/g, '_').toLowerCase()}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="px-2 py-2 border border-gray-300 font-bold uppercase hover:bg-gray-100"
                  >
                    {name}
                  </button>
                ))}
              </div>
            </Card>
          </>
        )}

        {activeScreen === 'mbcCardTypeMaster' && (
          <Card className="p-3 border border-gray-300 space-y-3">
            <div className="text-xs font-black uppercase">Create / Edit Card Type</div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
              <input className="border p-2" placeholder="Card Type Name" value={typeForm.type_name || ''} onChange={e => setTypeForm(prev => ({ ...prev, type_name: e.target.value }))} />
              <input className="border p-2" placeholder="Card Code" value={typeForm.type_code || ''} onChange={e => setTypeForm(prev => ({ ...prev, type_code: e.target.value }))} />
              <input className="border p-2" placeholder="Prefix" value={typeForm.prefix || ''} onChange={e => setTypeForm(prev => ({ ...prev, prefix: e.target.value }))} />
              <input type="number" className="border p-2" placeholder="Default Value" value={Number(typeForm.default_card_value || 0)} onChange={e => setTypeForm(prev => ({ ...prev, default_card_value: Number(e.target.value || 0) }))} />
              <input type="number" className="border p-2" placeholder="Validity Value" value={Number(typeForm.default_validity_value || 1)} onChange={e => setTypeForm(prev => ({ ...prev, default_validity_value: Number(e.target.value || 1) }))} />
              <select className="border p-2" value={typeForm.default_validity_unit || 'years'} onChange={e => setTypeForm(prev => ({ ...prev, default_validity_unit: e.target.value as ValidityUnit }))}>
                <option value="days">Days</option><option value="months">Months</option><option value="years">Years</option>
              </select>
              <select className="border p-2" value={typeForm.template_id || ''} onChange={e => setTypeForm(prev => ({ ...prev, template_id: e.target.value }))}>
                <option value="">Template Link</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.template_name}</option>)}
              </select>
              <div className="flex items-center gap-4 text-[10px] font-bold uppercase">
                <label><input type="checkbox" checked={typeForm.auto_numbering !== false} onChange={e => setTypeForm(prev => ({ ...prev, auto_numbering: e.target.checked }))} /> Auto No</label>
                <label><input type="checkbox" checked={typeForm.allow_renewal !== false} onChange={e => setTypeForm(prev => ({ ...prev, allow_renewal: e.target.checked }))} /> Renewal</label>
                <label><input type="checkbox" checked={typeForm.allow_upgrade !== false} onChange={e => setTypeForm(prev => ({ ...prev, allow_upgrade: e.target.checked }))} /> Upgrade</label>
              </div>
            </div>
            <textarea className="border p-2 w-full text-xs" placeholder="Benefit Description" value={typeForm.benefits || ''} onChange={e => setTypeForm(prev => ({ ...prev, benefits: e.target.value }))} />
            <textarea className="border p-2 w-full text-xs" placeholder="Terms & Conditions" value={typeForm.terms_conditions || ''} onChange={e => setTypeForm(prev => ({ ...prev, terms_conditions: e.target.value }))} />
            <button className="px-3 py-2 bg-primary text-white text-xs font-black uppercase" onClick={saveCardType}>Save Card Type</button>

            <div className="overflow-auto">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-gray-100"><tr><th className="p-2 text-left">Type</th><th className="p-2 text-left">Code</th><th className="p-2 text-left">Default Validity</th><th className="p-2 text-left">Default Value</th><th className="p-2 text-left">Prefix</th><th className="p-2 text-left">Actions</th></tr></thead>
                <tbody>
                  {cardTypes.map(t => (
                    <tr key={t.id} className="border-t"><td className="p-2">{t.type_name}</td><td className="p-2">{t.type_code}</td><td className="p-2">{t.default_validity_value} {t.default_validity_unit}</td><td className="p-2">{t.default_card_value}</td><td className="p-2">{t.prefix}</td><td className="p-2"><button className="px-2 py-1 border" onClick={() => setTypeForm(t)}>Edit</button></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {activeScreen === 'mbcCardTemplateMaster' && (
          <Card className="p-3 border border-gray-300 space-y-3">
            <div className="text-xs font-black uppercase">Create / Edit Template</div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
              <input className="border p-2" placeholder="Template Name" value={templateForm.template_name || ''} onChange={e => setTemplateForm(prev => ({ ...prev, template_name: e.target.value }))} />
              <input className="border p-2" placeholder="Template Code" value={templateForm.template_code || ''} onChange={e => setTemplateForm(prev => ({ ...prev, template_code: e.target.value }))} />
              <select className="border p-2" value={templateForm.card_type_id || ''} onChange={e => setTemplateForm(prev => ({ ...prev, card_type_id: e.target.value }))}>
                <option value="">Card Type Link</option>
                {cardTypes.map(t => <option key={t.id} value={t.id}>{t.type_name}</option>)}
              </select>
              <select className="border p-2" value={templateForm.orientation || 'landscape'} onChange={e => setTemplateForm(prev => ({ ...prev, orientation: e.target.value }))}>
                <option value="landscape">Landscape</option><option value="portrait">Portrait</option>
              </select>
              <input type="number" className="border p-2" placeholder="Card Width" value={Number(templateForm.width || 86)} onChange={e => setTemplateForm(prev => ({ ...prev, width: Number(e.target.value || 86) }))} />
              <input type="number" className="border p-2" placeholder="Card Height" value={Number(templateForm.height || 54)} onChange={e => setTemplateForm(prev => ({ ...prev, height: Number(e.target.value || 54) }))} />
              <input className="border p-2" placeholder="Background Image URL" value={templateForm.background_image || ''} onChange={e => setTemplateForm(prev => ({ ...prev, background_image: e.target.value }))} />
              <input className="border p-2" placeholder="Logo URL" value={templateForm.logo_image || ''} onChange={e => setTemplateForm(prev => ({ ...prev, logo_image: e.target.value }))} />
            </div>
            <textarea className="border p-2 w-full text-xs" placeholder="Template JSON (positions for name/phone/dob/address/validity/qr/footer)" value={typeof templateForm.template_json === 'string' ? templateForm.template_json : JSON.stringify(templateForm.template_json || {})} onChange={e => {
              try {
                setTemplateForm(prev => ({ ...prev, template_json: JSON.parse(e.target.value || '{}') }));
              } catch {
                setTemplateForm(prev => ({ ...prev, template_json: e.target.value }));
              }
            }} />
            <button className="px-3 py-2 bg-primary text-white text-xs font-black uppercase" onClick={saveTemplate}>Save Template</button>

            <div className="overflow-auto">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-gray-100"><tr><th className="p-2 text-left">Template</th><th className="p-2 text-left">Code</th><th className="p-2 text-left">Card Type</th><th className="p-2 text-left">Size</th><th className="p-2 text-left">Actions</th></tr></thead>
                <tbody>
                  {templates.map(t => (
                    <tr key={t.id} className="border-t"><td className="p-2">{t.template_name}</td><td className="p-2">{t.template_code}</td><td className="p-2">{cardTypeMap.get(t.card_type_id || '')?.type_name || '-'}</td><td className="p-2">{t.width}x{t.height}</td><td className="p-2"><button className="px-2 py-1 border" onClick={() => setTemplateForm(t)}>Edit</button></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {activeScreen === 'mbcGenerateCard' && (
          <Card className="p-3 border border-gray-300 space-y-3">
            <div className="text-xs font-black uppercase">Generate New MBC Card</div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
              <input className="border p-2" placeholder="Customer Name" value={cardForm.customer_name || ''} onChange={e => setCardForm(prev => ({ ...prev, customer_name: e.target.value }))} />
              <input className="border p-2" placeholder="Guardian Name" value={cardForm.guardian_name || ''} onChange={e => setCardForm(prev => ({ ...prev, guardian_name: e.target.value }))} />
              <select className="border p-2" value={cardForm.gender || ''} onChange={e => setCardForm(prev => ({ ...prev, gender: e.target.value }))}>
                <option value="">Gender</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Other">Other</option>
              </select>
              <input className="border p-2" placeholder="Address Line 1" value={cardForm.address_line_1 || ''} onChange={e => setCardForm(prev => ({ ...prev, address_line_1: e.target.value }))} />
              <input className="border p-2" placeholder="Address Line 2" value={cardForm.address_line_2 || ''} onChange={e => setCardForm(prev => ({ ...prev, address_line_2: e.target.value }))} />
              <input className="border p-2" placeholder="City / Town / Village" value={cardForm.city || ''} onChange={e => setCardForm(prev => ({ ...prev, city: e.target.value }))} />
              <input className="border p-2" placeholder="District" value={cardForm.district || ''} onChange={e => setCardForm(prev => ({ ...prev, district: e.target.value }))} />
              <input className="border p-2" placeholder="State" value={cardForm.state || ''} onChange={e => setCardForm(prev => ({ ...prev, state: e.target.value }))} />
              <input className="border p-2" placeholder="PIN Code" value={cardForm.pin_code || ''} onChange={e => setCardForm(prev => ({ ...prev, pin_code: e.target.value }))} />
              <input className="border p-2" placeholder="Phone Number" value={cardForm.phone_number || ''} onChange={e => setCardForm(prev => ({ ...prev, phone_number: e.target.value.replace(/\D/g, '').slice(0, 10) }))} />
              <input className="border p-2" placeholder="Alternate Phone" value={cardForm.alternate_phone || ''} onChange={e => setCardForm(prev => ({ ...prev, alternate_phone: e.target.value }))} />
              <input className="border p-2" placeholder="Email" value={cardForm.email || ''} onChange={e => setCardForm(prev => ({ ...prev, email: e.target.value }))} />
              <select className="border p-2" value={cardForm.card_type_id || ''} onChange={e => applyDefaultsFromType(e.target.value)}>
                <option value="">Card Type</option>
                {cardTypes.filter(t => t.is_active !== false).map(t => <option key={t.id} value={t.id}>{t.type_name}</option>)}
              </select>
              <input className="border p-2" placeholder="Card Number" value={cardForm.card_number || ''} onChange={e => setCardForm(prev => ({ ...prev, card_number: e.target.value }))} />
              <input type="number" className="border p-2" placeholder="Card Value" value={Number(cardForm.card_value || 0)} onChange={e => setCardForm(prev => ({ ...prev, card_value: Number(e.target.value || 0) }))} disabled={!cardTypeMap.get(cardForm.card_type_id || '')?.allow_manual_value_edit} />
              <select className="border p-2" value={cardForm.template_id || ''} onChange={e => setCardForm(prev => ({ ...prev, template_id: e.target.value }))}>
                <option value="">Card Template</option>
                {templates.filter(t => !cardForm.card_type_id || t.card_type_id === cardForm.card_type_id).map(t => <option key={t.id} value={t.id}>{t.template_name}</option>)}
              </select>
              <input className="border p-2" placeholder="QR / Barcode value" value={cardForm.qr_value || ''} onChange={e => setCardForm(prev => ({ ...prev, qr_value: e.target.value }))} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
              <label className="flex flex-col gap-1">
                <span className="font-bold uppercase">Date of Birth (dd-mm-yyyy) *</span>
                <input
                  className="border p-2"
                  type="date"
                  value={cardForm.date_of_birth || ''}
                  max={toDateInput(new Date())}
                  onChange={e => setCardForm(prev => ({ ...prev, date_of_birth: e.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-bold uppercase">Validity From (dd-mm-yyyy) *</span>
                <input
                  className="border p-2"
                  type="date"
                  value={cardForm.validity_from || ''}
                  onChange={e => setCardForm(prev => ({ ...prev, validity_from: e.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-bold uppercase">Validity To (dd-mm-yyyy) *</span>
                <input
                  className="border p-2"
                  type="date"
                  value={cardForm.validity_to || ''}
                  onChange={e => setCardForm(prev => ({ ...prev, validity_to: e.target.value }))}
                />
              </label>
            </div>
            <textarea className="border p-2 w-full text-xs" placeholder="Remarks / Notes" value={cardForm.remarks || ''} onChange={e => setCardForm(prev => ({ ...prev, remarks: e.target.value }))} />

            <div className="flex gap-2">
              <button className="px-3 py-2 bg-primary text-white text-xs font-black uppercase" onClick={saveCard}>Save / Generate Card</button>
              <button className="px-3 py-2 border border-gray-400 text-xs font-black uppercase" onClick={() => setSelectedCardId(cardForm.id || '')}>Preview Current</button>
            </div>
          </Card>
        )}

        {activeScreen === 'mbcCardList' && (
          <Card className="p-3 border border-gray-300 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
              <input className="border p-2" placeholder="Search by card/customer/phone/address/card type" value={search} onChange={e => setSearch(e.target.value)} />
              <select className="border p-2" value={cardTypeFilter} onChange={e => setCardTypeFilter(e.target.value)}>
                <option value="">All Card Types</option>
                {cardTypes.map(t => <option key={t.id} value={t.id}>{t.type_name}</option>)}
              </select>
              <select className="border p-2" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="">All Status</option>
                <option value="active">Active</option>
                <option value="expired">Expired</option>
                <option value="upcoming">Upcoming</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <div className="overflow-auto">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-gray-100 sticky top-0"><tr>
                  {['Card Number', 'Customer Name', 'Date of Birth', 'Address', 'Phone Number', 'Card Type', 'Card Value', 'Validity From', 'Validity To', 'Validity Period', 'Status', 'Created By', 'Created Date', 'Actions'].map(h => (
                    <th key={h} className="p-2 text-left border-r">{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {filteredCards.map(card => {
                    const status = getCardStatus(card);
                    return (
                      <tr key={card.id} className="border-t">
                        <td className="p-2">{card.card_number}</td>
                        <td className="p-2">{card.customer_name}</td>
                        <td className="p-2">{card.date_of_birth || '-'}</td>
                        <td className="p-2">{[card.address_line_1, card.address_line_2, card.city].filter(Boolean).join(', ')}</td>
                        <td className="p-2">{card.phone_number}</td>
                        <td className="p-2">{cardTypeMap.get(card.card_type_id)?.type_name || '-'}</td>
                        <td className="p-2">{card.card_value}</td>
                        <td className="p-2">{card.validity_from}</td>
                        <td className="p-2">{card.validity_to}</td>
                        <td className="p-2">{card.validity_period_text}</td>
                        <td className="p-2 uppercase font-bold">{status}</td>
                        <td className="p-2">{card.created_by}</td>
                        <td className="p-2">{card.created_at?.slice(0, 10)}</td>
                        <td className="p-2 whitespace-nowrap">
                          <button className="px-2 py-1 border mr-1" onClick={() => { setCardForm(card); onNavigate('mbcGenerateCard'); }}>Edit</button>
                          <button className="px-2 py-1 border mr-1" onClick={() => { setSelectedCardId(card.id); onNavigate('mbcCardPrintPreview'); }}>Print</button>
                          <button className="px-2 py-1 border mr-1" onClick={() => { setSelectedCardId(card.id); onNavigate('mbcCardRenewalHistory'); }}>Renew/Upgrade</button>
                          <button className="px-2 py-1 border" onClick={async () => { await supabase.from('mbc_cards').update({ status: 'inactive' }).eq('id', card.id); refreshAll(); }}>Deactivate</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {activeScreen === 'mbcCardPrintPreview' && (
          <Card className="p-3 border border-gray-300 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
              <select className="border p-2" value={selectedCardId || ''} onChange={e => setSelectedCardId(e.target.value)}>
                <option value="">Select card to preview</option>
                {cards.map(c => <option key={c.id} value={c.id}>{c.card_number} - {c.customer_name}</option>)}
              </select>
              <input className="border p-2" placeholder="Search card number/customer/phone" onChange={e => {
                const q = e.target.value.toLowerCase();
                const found = cards.find(c => [c.card_number, c.customer_name, c.phone_number].join(' ').toLowerCase().includes(q));
                if (found) setSelectedCardId(found.id);
              }} />
              <button className="px-3 py-2 border border-gray-300 font-black uppercase" onClick={refreshAll}>Re-generate Preview</button>
            </div>

            {printPreviewCard ? (
              <>
                <div className="border p-4 bg-white max-w-[500px]" style={{ aspectRatio: `${Number(printTemplate?.width || 86)} / ${Number(printTemplate?.height || 54)}`, backgroundImage: printTemplate?.background_image ? `url(${printTemplate.background_image})` : undefined, backgroundSize: 'cover' }}>
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="text-sm font-black uppercase">{printType?.type_name || 'Membership Card'}</div>
                      <div className="text-lg font-black uppercase text-primary mt-2">{printPreviewCard.customer_name}</div>
                      <div className="text-xs mt-1">Card No: {printPreviewCard.card_number}</div>
                      <div className="text-xs">Phone: {printPreviewCard.phone_number}</div>
                      <div className="text-xs">DOB: {printPreviewCard.date_of_birth || '-'}</div>
                      <div className="text-xs">Validity: {printPreviewCard.validity_from} to {printPreviewCard.validity_to}</div>
                    </div>
                    <div className="w-20 h-20 border border-dashed flex items-center justify-center text-[9px] text-center p-1">QR / Barcode\n{printPreviewCard.qr_value || ''}</div>
                  </div>
                  <div className="text-[10px] mt-3">Address: {[printPreviewCard.address_line_1, printPreviewCard.address_line_2, printPreviewCard.city].filter(Boolean).join(', ')}</div>
                  <div className="text-[10px] mt-2">{printPreviewCard.website_link || 'www.mdxera.com'} | {printPreviewCard.office_location_text || 'Office'}</div>
                </div>
                <div className="flex gap-2">
                  <button className="px-3 py-2 bg-primary text-white text-xs font-black uppercase" onClick={() => window.print()}>Print</button>
                  <button className="px-3 py-2 border border-gray-300 text-xs font-black uppercase" onClick={() => {
                    const text = JSON.stringify(printPreviewCard, null, 2);
                    const blob = new Blob([text], { type: 'application/pdf' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${printPreviewCard.card_number}.pdf`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}>Export PDF</button>
                  <button className="px-3 py-2 border border-gray-300 text-xs font-black uppercase" onClick={() => {
                    const text = JSON.stringify(printPreviewCard, null, 2);
                    const blob = new Blob([text], { type: 'image/png' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${printPreviewCard.card_number}.png`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}>Download Image</button>
                </div>
              </>
            ) : <div className="text-xs text-gray-500">Select card to preview.</div>}
          </Card>
        )}

        {activeScreen === 'mbcCardRenewalHistory' && (
          <Card className="p-3 border border-gray-300 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
              <select className="border p-2" value={selectedCardId || ''} onChange={e => setSelectedCardId(e.target.value)}>
                <option value="">Select Card</option>
                {cards.map(c => <option key={c.id} value={c.id}>{c.card_number} - {c.customer_name}</option>)}
              </select>
              <input type="number" className="border p-2" value={renewMonths} onChange={e => setRenewMonths(Number(e.target.value || 1))} placeholder="Renew Months" />
              <select className="border p-2" value={upgradeTypeId} onChange={e => setUpgradeTypeId(e.target.value)}>
                <option value="">Upgrade Type</option>
                {cardTypes.map(t => <option key={t.id} value={t.id}>{t.type_name}</option>)}
              </select>
              <input className="border p-2" value={historyRemarks} onChange={e => setHistoryRemarks(e.target.value)} placeholder="Renewal remarks" />
            </div>
            <div className="flex gap-2">
              <button className="px-3 py-2 bg-primary text-white text-xs font-black uppercase" onClick={() => doRenewUpgrade('renew')}>Renew Same Card</button>
              <button className="px-3 py-2 border border-gray-300 text-xs font-black uppercase" onClick={() => doRenewUpgrade('upgrade')}>Upgrade Card Type</button>
            </div>

            <div className="overflow-auto">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-gray-100"><tr><th className="p-2 text-left">Date</th><th className="p-2 text-left">Action</th><th className="p-2 text-left">Old Type</th><th className="p-2 text-left">New Type</th><th className="p-2 text-left">Old Validity</th><th className="p-2 text-left">New Validity</th><th className="p-2 text-left">Old Value</th><th className="p-2 text-left">New Value</th><th className="p-2 text-left">Remarks</th><th className="p-2 text-left">By</th></tr></thead>
                <tbody>
                  {history.filter(h => !selectedCardId || h.mbc_card_id === selectedCardId).map(h => (
                    <tr key={h.id} className="border-t">
                      <td className="p-2">{h.action_date?.slice(0, 10)}</td>
                      <td className="p-2 uppercase">{h.action_type}</td>
                      <td className="p-2">{cardTypeMap.get(h.old_card_type_id || '')?.type_name || '-'}</td>
                      <td className="p-2">{cardTypeMap.get(h.new_card_type_id || '')?.type_name || '-'}</td>
                      <td className="p-2">{h.old_validity_to || '-'}</td>
                      <td className="p-2">{h.new_validity_to || '-'}</td>
                      <td className="p-2">{h.old_card_value ?? '-'}</td>
                      <td className="p-2">{h.new_card_value ?? '-'}</td>
                      <td className="p-2">{h.remarks || '-'}</td>
                      <td className="p-2">{h.action_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </main>
  );
};

export default MbcCardManagement;
