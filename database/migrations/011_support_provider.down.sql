DO $$ BEGIN
 IF EXISTS(SELECT FROM platform.support_provider WHERE key_cipher IS NOT NULL OR endpoint<>'')
 THEN RAISE EXCEPTION 'AI provider configuration is not empty; forward repair required'; END IF;
END $$;
DROP TABLE platform.support_provider;
