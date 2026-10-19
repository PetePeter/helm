export type FilterPreferenceState = 'either' | 'yes' | 'no';

export interface PlanFilterPreferences {
  types: { bug: FilterPreferenceState; feature: FilterPreferenceState; research: FilterPreferenceState; untyped: FilterPreferenceState };
  statuses: { planning: FilterPreferenceState; ready: FilterPreferenceState; coding: FilterPreferenceState; review: FilterPreferenceState; blocked: FilterPreferenceState; done: FilterPreferenceState };
  hasAttachment: { yes: FilterPreferenceState; no: FilterPreferenceState };
  auto: FilterPreferenceState;
}

export interface FilterPreferenceChanged {
  id: string;
  value: unknown;
}
