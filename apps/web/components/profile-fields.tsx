"use client";
import { COUNTRIES, INDIAN_STATES } from "@/lib/api";
import { Field, Input, Select } from "./ui";

export interface ProfileValues {
  firstName: string;
  lastName: string;
  phone: string;
  companyName: string;
  gstin: string;
  pan: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  country: string;
  postcode: string;
}
export const emptyProfile: ProfileValues = { firstName: "", lastName: "", phone: "", companyName: "", gstin: "", pan: "", address1: "", address2: "", city: "", state: "", country: "IN", postcode: "" };

export function ProfileFields({ v, set, errors = {} }: { v: ProfileValues; set: (p: Partial<ProfileValues>) => void; errors?: Record<string, string[] | undefined> }) {
  const err = (k: string) => errors[k]?.[0];
  const india = v.country === "IN";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="First name" error={err("firstName")}>
        <Input required value={v.firstName} onChange={(e) => set({ firstName: e.target.value })} autoComplete="given-name" />
      </Field>
      <Field label="Last name" error={err("lastName")}>
        <Input value={v.lastName} onChange={(e) => set({ lastName: e.target.value })} autoComplete="family-name" />
      </Field>
      <Field label="Phone number" error={err("phone")}>
        <Input required type="tel" value={v.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="+91 98xxx xxxxx" autoComplete="tel" />
      </Field>
      <Field label="Company name (optional)" error={err("companyName")}>
        <Input value={v.companyName} onChange={(e) => set({ companyName: e.target.value })} autoComplete="organization" />
      </Field>
      {india && (
        <>
          <Field label="GSTIN (optional)" hint="Add your GSTIN to claim input tax credit on invoices." error={err("gstin")}>
            <Input value={v.gstin} onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} maxLength={15} placeholder="23ABCDE1234F1Z5" />
          </Field>
          <Field label="PAN (optional)" error={err("pan")}>
            <Input value={v.pan} onChange={(e) => set({ pan: e.target.value.toUpperCase() })} maxLength={10} placeholder="ABCDE1234F" />
          </Field>
        </>
      )}
      <Field label="Billing address" className="sm:col-span-2" error={err("address1")}>
        <Input required value={v.address1} onChange={(e) => set({ address1: e.target.value })} autoComplete="address-line1" placeholder="House / building, street" />
      </Field>
      <Field label="Address line 2 (optional)" className="sm:col-span-2">
        <Input value={v.address2} onChange={(e) => set({ address2: e.target.value })} autoComplete="address-line2" />
      </Field>
      <Field label="Country">
        <Select value={v.country} onChange={(e) => set({ country: e.target.value, state: "" })}>
          {COUNTRIES.map(([c, n]) => (
            <option key={c} value={c}>
              {n}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={india ? "State (place of supply)" : "State / region"} error={err("state")}>
        {india ? (
          <Select required value={v.state} onChange={(e) => set({ state: e.target.value })}>
            <option value="">Select state…</option>
            {INDIAN_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        ) : (
          <Input required value={v.state} onChange={(e) => set({ state: e.target.value })} />
        )}
      </Field>
      <Field label="City" error={err("city")}>
        <Input required value={v.city} onChange={(e) => set({ city: e.target.value })} autoComplete="address-level2" />
      </Field>
      <Field label={india ? "PIN code" : "Postal code"} error={err("postcode")}>
        <Input required value={v.postcode} onChange={(e) => set({ postcode: e.target.value })} autoComplete="postal-code" inputMode={india ? "numeric" : undefined} />
      </Field>
    </div>
  );
}
