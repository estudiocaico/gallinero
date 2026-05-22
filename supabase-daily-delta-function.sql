create or replace function public.gallinero_add_daily_delta(
  p_row_id text,
  p_date text,
  p_flock text,
  p_tab text,
  p_delta jsonb,
  p_notes jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_data jsonb;
  v_daily jsonb;
  v_entry jsonb;
  v_index integer := null;
  v_item jsonb;
  v_field text;
  v_note_field text;
  v_old_note text;
  v_new_note text;
  v_sections jsonb;
begin
  select data
    into v_data
    from public.gallinero_state
    where id = p_row_id
    for update;

  if v_data is null then
    v_data := jsonb_build_object(
      'hens', 183,
      'flocks', jsonb_build_object('Gallinas', 183, 'Pigmeas', 0),
      'daily', '[]'::jsonb,
      'stock', '[]'::jsonb,
      'health', '[]'::jsonb,
      'flockEvents', '[]'::jsonb
    );
  end if;

  v_daily := coalesce(v_data->'daily', '[]'::jsonb);

  for v_index in 0..greatest(jsonb_array_length(v_daily) - 1, 0) loop
    v_item := v_daily->v_index;
    if v_item->>'date' = p_date
      and coalesce(v_item->>'flock', 'Gallinas') = p_flock
      and coalesce(v_item->>'entryType', '') = '' then
      v_entry := v_item;
      exit;
    end if;
  end loop;

  if v_entry is null then
    v_index := null;
    v_entry := jsonb_build_object(
      'id', 'entry-' || md5(random()::text || clock_timestamp()::text),
      'date', p_date,
      'flock', p_flock,
      'entryType', '',
      'morningEggs', 0,
      'afternoonEggs', 0,
      'lostEggs', 0,
      'cornKg', 0,
      'feedKg', 0,
      'waterLiters', 0,
      'dailyCost', 0,
      'productionNotes', '',
      'consumptionNotes', '',
      'expenseNotes', '',
      'updatedSections', '{}'::jsonb
    );
  end if;

  foreach v_field in array array['morningEggs', 'afternoonEggs', 'lostEggs', 'cornKg', 'feedKg', 'waterLiters', 'dailyCost'] loop
    if p_delta ? v_field then
      v_entry := jsonb_set(
        v_entry,
        array[v_field],
        to_jsonb(coalesce((v_entry->>v_field)::numeric, 0) + coalesce((p_delta->>v_field)::numeric, 0)),
        true
      );
    end if;
  end loop;

  foreach v_note_field in array array['productionNotes', 'consumptionNotes', 'expenseNotes'] loop
    if p_notes ? v_note_field then
      v_new_note := trim(coalesce(p_notes->>v_note_field, ''));
      if v_new_note <> '' then
        v_old_note := coalesce(v_entry->>v_note_field, '');
        if v_old_note = '' then
          v_entry := jsonb_set(v_entry, array[v_note_field], to_jsonb(v_new_note), true);
        else
          v_entry := jsonb_set(v_entry, array[v_note_field], to_jsonb(v_old_note || E'\n' || v_new_note), true);
        end if;
      end if;
    end if;
  end loop;

  v_sections := coalesce(v_entry->'updatedSections', '{}'::jsonb) || jsonb_build_object(p_tab, true);
  v_entry := jsonb_set(v_entry, '{updatedSections}', v_sections, true);

  if v_index is null then
    v_daily := v_daily || jsonb_build_array(v_entry);
  else
    v_daily := jsonb_set(v_daily, array[v_index::text], v_entry, true);
  end if;

  v_data := jsonb_set(v_data, '{daily}', v_daily, true);
  v_data := jsonb_set(v_data, '{hens}', to_jsonb(coalesce((v_data->'flocks'->>'Gallinas')::numeric, 183)), true);

  insert into public.gallinero_state (id, data, updated_at)
  values (p_row_id, v_data, now())
  on conflict (id)
  do update set data = excluded.data, updated_at = excluded.updated_at;

  return v_data;
end;
$$;

grant execute on function public.gallinero_add_daily_delta(text, text, text, text, jsonb, jsonb) to anon;
