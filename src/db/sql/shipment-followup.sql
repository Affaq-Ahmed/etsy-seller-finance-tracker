-- Status dates respect shipment creation; historical NOTE events remain valid.
CREATE OR REPLACE FUNCTION guard_shipment_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE shipment shipments; last_status_date timestamptz; allowed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Shipment events are append-only'; END IF;
  SELECT * INTO shipment FROM shipments WHERE account_id = NEW.account_id AND id = NEW.shipment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shipment event requires a same-tenant shipment'; END IF;
  IF NEW.event_type = 'NOTE' THEN RETURN NEW; END IF;
  IF NEW.event_date < shipment.created_at THEN
    RAISE EXCEPTION 'Shipment status event cannot precede shipment creation';
  END IF;
  IF NEW.event_type = 'PENDING' THEN
    IF pg_trigger_depth() < 2 OR EXISTS (SELECT 1 FROM shipment_events WHERE shipment_id = shipment.id) THEN
      RAISE EXCEPTION 'Only shipment creation may append the initial PENDING event';
    END IF;
    RETURN NEW;
  END IF;
  SELECT max(event_date) INTO last_status_date FROM shipment_events WHERE shipment_id = shipment.id AND event_type NOT IN ('PENDING','NOTE');
  IF last_status_date IS NOT NULL AND NEW.event_date < last_status_date THEN
    RAISE EXCEPTION 'Status events must be chronological; append a NOTE for historical observations';
  END IF;
  allowed := CASE shipment.shipment_status
    WHEN 'PENDING' THEN NEW.event_type IN ('SHIPPED','CANCELLED')
    WHEN 'SHIPPED' THEN NEW.event_type IN ('IN_TRANSIT','DELIVERED','EXCEPTION','RETURNED','CANCELLED')
    WHEN 'IN_TRANSIT' THEN NEW.event_type IN ('IN_TRANSIT','DELIVERED','EXCEPTION','RETURNED')
    WHEN 'EXCEPTION' THEN NEW.event_type IN ('IN_TRANSIT','DELIVERED','RETURNED','CANCELLED','EXCEPTION')
    WHEN 'DELIVERED' THEN NEW.event_type = 'RETURNED'
    ELSE false END;
  IF NOT allowed THEN RAISE EXCEPTION 'Invalid shipment status transition: % -> %', shipment.shipment_status, NEW.event_type; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_shipment_metadata_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.carrier, NEW.tracking_number, NEW.tracking_url, NEW.estimated_delivery_at, NEW.notes)
    IS DISTINCT FROM ROW(OLD.carrier, OLD.tracking_number, OLD.tracking_url, OLD.estimated_delivery_at, OLD.notes) THEN
    INSERT INTO shipment_events(account_id, shipment_id, event_type, event_date, description)
      VALUES(NEW.account_id, NEW.id, 'NOTE', clock_timestamp(), 'Manual shipment metadata updated');
    INSERT INTO audit_logs(account_id, entity_type, entity_id, action, before_data, after_data)
      VALUES(NEW.account_id, 'shipment', NEW.id, 'METADATA_UPDATED',
        jsonb_build_object('carrier',OLD.carrier,'tracking_number',OLD.tracking_number,'tracking_url',OLD.tracking_url,'estimated_delivery_at',OLD.estimated_delivery_at,'notes',OLD.notes),
        jsonb_build_object('carrier',NEW.carrier,'tracking_number',NEW.tracking_number,'tracking_url',NEW.tracking_url,'estimated_delivery_at',NEW.estimated_delivery_at,'notes',NEW.notes));
  END IF;
  RETURN NULL;
END $$;
