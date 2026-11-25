-- Shipments are independent of order delivery/payout eligibility.
CREATE FUNCTION guard_shipment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Shipment history cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.shipment_status <> 'PENDING' OR NEW.shipped_at IS NOT NULL OR NEW.delivered_at IS NOT NULL THEN
      RAISE EXCEPTION 'Create a pending shipment, then append status events';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.account_id, NEW.order_id, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.account_id, OLD.order_id, OLD.created_at) THEN
      RAISE EXCEPTION 'Shipment identity and order are immutable';
    END IF;
    IF ROW(NEW.shipment_status, NEW.shipped_at, NEW.delivered_at) IS DISTINCT FROM ROW(OLD.shipment_status, OLD.shipped_at, OLD.delivered_at)
      AND pg_trigger_depth() < 2 THEN RAISE EXCEPTION 'Change shipment status by appending an event'; END IF;
    NEW.updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_shipment_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE shipment shipments; last_status_date timestamptz; allowed boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Shipment events are append-only'; END IF;
  SELECT * INTO shipment FROM shipments WHERE account_id = NEW.account_id AND id = NEW.shipment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shipment event requires a same-tenant shipment'; END IF;
  IF NEW.event_type = 'NOTE' THEN RETURN NEW; END IF;
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
CREATE FUNCTION project_shipment_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type NOT IN ('NOTE','PENDING') THEN
    UPDATE shipments SET shipment_status = NEW.event_type::text::shipment_status,
      shipped_at = CASE WHEN NEW.event_type = 'SHIPPED' THEN NEW.event_date ELSE shipped_at END,
      delivered_at = CASE WHEN NEW.event_type = 'DELIVERED' THEN NEW.event_date ELSE delivered_at END
      WHERE account_id = NEW.account_id AND id = NEW.shipment_id;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION initialize_shipment_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO shipment_events(account_id, shipment_id, event_type, event_date, description)
    VALUES(NEW.account_id, NEW.id, 'PENDING', NEW.created_at, 'Shipment created');
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION record_shipment_metadata_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.carrier, NEW.tracking_number, NEW.tracking_url, NEW.estimated_delivery_at, NEW.notes)
    IS DISTINCT FROM ROW(OLD.carrier, OLD.tracking_number, OLD.tracking_url, OLD.estimated_delivery_at, OLD.notes) THEN
    INSERT INTO shipment_events(account_id, shipment_id, event_type, event_date, description)
      VALUES(NEW.account_id, NEW.id, 'NOTE', clock_timestamp(), 'Manual shipment metadata updated');
    INSERT INTO audit_logs(account_id, entity_type, entity_id, action, before_data, after_data)
      VALUES(NEW.account_id, 'shipment', NEW.id, 'METADATA_UPDATED',
        jsonb_build_object('carrier',OLD.carrier,'tracking_number',OLD.tracking_number,'tracking_url',OLD.tracking_url,'estimated_delivery_at',OLD.estimated_delivery_at),
        jsonb_build_object('carrier',NEW.carrier,'tracking_number',NEW.tracking_number,'tracking_url',NEW.tracking_url,'estimated_delivery_at',NEW.estimated_delivery_at));
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER a_lock_shipments BEFORE INSERT OR UPDATE OR DELETE ON shipments
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();
--> statement-breakpoint
CREATE TRIGGER a_lock_shipment_events BEFORE INSERT OR UPDATE OR DELETE ON shipment_events
FOR EACH ROW EXECUTE FUNCTION lock_financial_tenant();
--> statement-breakpoint
CREATE TRIGGER shipments_guard BEFORE INSERT OR UPDATE OR DELETE ON shipments
FOR EACH ROW EXECUTE FUNCTION guard_shipment();
--> statement-breakpoint
CREATE TRIGGER shipment_events_guard BEFORE INSERT OR UPDATE OR DELETE ON shipment_events
FOR EACH ROW EXECUTE FUNCTION guard_shipment_event();
--> statement-breakpoint
CREATE TRIGGER shipment_events_project AFTER INSERT ON shipment_events
FOR EACH ROW EXECUTE FUNCTION project_shipment_event();
--> statement-breakpoint
CREATE TRIGGER shipments_initialize AFTER INSERT ON shipments
FOR EACH ROW EXECUTE FUNCTION initialize_shipment_history();
--> statement-breakpoint
CREATE TRIGGER shipments_metadata_history AFTER UPDATE ON shipments
FOR EACH ROW EXECUTE FUNCTION record_shipment_metadata_change();

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
