INSERT INTO users(id,username,password_hash)
SELECT lpad(i::text,26,'0'), 'evidence-user-'||i, 'x' FROM generate_series(1,10002) i;
INSERT INTO chats(id,kind,name,owner_id,member_count,next_sequence,last_activity_at)
VALUES (lpad('10000000',26,'0'),'GROUP','Million messages',lpad('1',26,'0'),10002,1100001,now());
INSERT INTO chat_members(chat_id,user_id)
SELECT lpad('10000000',26,'0'),lpad(i::text,26,'0') FROM generate_series(1,10002) i;
INSERT INTO chats(id,kind,direct_pair_key,member_count,next_sequence,last_activity_at)
SELECT lpad((10000000+i)::text,26,'0'),'DIRECT',lpad('1',26,'0')||':'||lpad((i+2)::text,26,'0'),2,21,now()-i*interval '1 second'
FROM generate_series(1,5200) i;
INSERT INTO chat_members(chat_id,user_id,joined_at)
SELECT id,lpad('1',26,'0'),now()-interval '1 year' FROM chats WHERE kind='DIRECT';
INSERT INTO chat_members(chat_id,user_id)
SELECT lpad((10000000+i)::text,26,'0'),lpad((i+2)::text,26,'0') FROM generate_series(1,5200) i;
INSERT INTO messages(id,chat_id,sequence,sender_id,body,created_at)
SELECT lpad((100000000+i)::text,26,'0'),lpad('10000000',26,'0'),i,
 lpad((CASE WHEN i%3=0 THEN 1 ELSE 2 END)::text,26,'0'),repeat('message ',20),now()-interval '1 day'
FROM generate_series(1,1100000) i;
DELETE FROM messages WHERE chat_id=lpad('10000000',26,'0') AND sequence%97=0;
INSERT INTO messages(id,chat_id,sequence,sender_id,body,created_at)
SELECT lpad((200000000+i*20+j)::text,26,'0'),lpad((10000000+i)::text,26,'0'),j,
 lpad((CASE WHEN j%3=0 THEN 1 ELSE i+2 END)::text,26,'0'),repeat('direct ',12),now()-i*interval '1 second'
FROM generate_series(1,5200) i CROSS JOIN generate_series(1,20) j;
INSERT INTO hidden_message_ranges(chat_id,user_id,after_sequence,through_sequence)
SELECT lpad('10000000',26,'0'),lpad('1',26,'0'),i*10,i*10+5 FROM generate_series(1,110000) i;
INSERT INTO chat_read_progress(chat_id,user_id,through_sequence,read_at)
VALUES (lpad('10000000',26,'0'),lpad('1',26,'0'),1000000,now());
VACUUM ANALYZE;
