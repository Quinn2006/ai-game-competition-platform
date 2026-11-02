// All expiries are calculated from the later publication/appeal closure date.
export async function cleanupCompetition(c){
 await c.query(`DELETE FROM platform.contest_signals e WHERE e.occurred_at<CURRENT_TIMESTAMP-interval '30 days'
 AND NOT EXISTS(SELECT 1 FROM platform.contest_subjects s WHERE s.work_id=e.work_id AND
 (platform.contest_closed_at(s.contest_id) IS NULL OR platform.contest_closed_at(s.contest_id)>CURRENT_TIMESTAMP-interval '180 days'))
 AND NOT EXISTS(SELECT 1 FROM platform.community_risks r WHERE r.work_id=e.work_id AND (r.resolved_at IS NULL OR r.hold_until IS NOT NULL))`);
 await c.query('DELETE FROM platform.contest_aliases a WHERE NOT EXISTS(SELECT 1 FROM platform.contest_signals e WHERE e.day=a.day AND (e.identity_key=a.browser_hash OR e.identity_key=a.identity_hash))');
 const expired=(await c.query(`SELECT ct.id FROM platform.competitions ct WHERE ct.archived_at IS NULL AND platform.contest_closed_at(ct.id)<CURRENT_TIMESTAMP-interval '1 year'
 AND NOT EXISTS(SELECT 1 FROM platform.contest_subjects s JOIN platform.community_risks r ON r.work_id=s.work_id WHERE s.contest_id=ct.id AND (r.resolved_at IS NULL OR r.hold_until IS NOT NULL)) FOR UPDATE OF ct`)).rows;
 for(const {id} of expired){
  await c.query("UPDATE platform.contest_results SET evidence='{}' WHERE contest_id=$1 AND evidence<>'{}'",[id]);
  await c.query('DELETE FROM platform.contest_appeals WHERE result_id IN(SELECT id FROM platform.contest_results WHERE contest_id=$1)',[id]);
  await c.query('DELETE FROM platform.contest_events WHERE contest_id=$1',[id]);
  for(const table of ['contest_reviews','contest_changes','contest_invites'])await c.query(`DELETE FROM platform.${table} WHERE subject_id IN(SELECT id FROM platform.contest_subjects WHERE contest_id=$1)`,[id]);
  await c.query('DELETE FROM platform.contest_members WHERE contest_id=$1',[id]);
  await c.query('UPDATE platform.contest_subjects SET captain_id=NULL WHERE contest_id=$1',[id]);
  await c.query('UPDATE platform.competitions SET archived_at=CURRENT_TIMESTAMP WHERE id=$1',[id]);
 }
}
