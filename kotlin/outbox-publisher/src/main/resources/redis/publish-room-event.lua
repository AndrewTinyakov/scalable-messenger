assert(#KEYS == 4 and #ARGV == 3, 'invalid publication argument count')

local options = cjson.decode(ARGV[2])
local event = cjson.decode(ARGV[1])
local replay = cjson.decode(ARGV[3])
assert(type(options) == 'table' and options.version == 1, 'unsupported publication arguments')
assert(type(options.room) == 'string' and options.room ~= '', 'invalid publication room')
assert(type(options.epoch) == 'string' and options.epoch ~= '', 'invalid publication epoch')
assert(type(options.eventId) == 'string' and options.eventId ~= '', 'invalid publication identity')
assert(type(options.historyMaxLength) == 'number' and options.historyMaxLength > 0
    and options.historyMaxLength % 1 == 0, 'invalid history length')
assert(type(options.historyMaxBytes) == 'number' and options.historyMaxBytes >= #ARGV[3], 'invalid history byte budget')
assert(type(options.historySeconds) == 'number' and options.historySeconds > 0, 'invalid history window')
assert(type(options.idleTtlSeconds) == 'number' and options.idleTtlSeconds > 0
    and options.idleTtlSeconds % 1 == 0, 'invalid idle TTL')
assert(type(event) == 'table' and event.room == options.room, 'event room mismatch')
assert(event.eventId == options.eventId, 'event identity mismatch')
assert(type(replay) == 'table' and replay.room == options.room and replay.eventId == options.eventId, 'replay identity mismatch')
assert(replay.body == nil and replay.replyBody == nil, 'replay content is forbidden')
local order = options.groupPublicationOrder
if order == cjson.null then order = nil end
assert(not order or (type(order) == 'string' and string.match(order, '^[1-9]%d*$')), 'invalid publication order')

local prefix = 'messenger:{' .. options.room .. '}'
assert(KEYS[1] == prefix .. ':stream' and KEYS[2] == prefix .. ':epoch'
    and KEYS[3] == prefix .. ':live' and KEYS[4] == prefix .. ':history-bytes', 'publication key mismatch')

local epoch = redis.call('GET', KEYS[2])
local previousStreamId = ''
local historyBytes = tonumber(redis.call('GET', KEYS[4]))
if not epoch or not historyBytes or redis.call('EXISTS', KEYS[1]) == 0 then
    redis.call('DEL', KEYS[1])
    historyBytes = 0
    epoch = options.epoch
    redis.call('SET', KEYS[2], epoch)
else
    local previous = redis.call('XREVRANGE', KEYS[1], '+', '-', 'COUNT', 1)
    if #previous > 0 then
        previousStreamId = previous[1][1]
        if order then
            local fields = previous[1][2]
            for i = 1, #fields, 2 do
                if fields[i] == 'groupPublicationOrder' then
                    local lastOrder = fields[i + 1]
                    if #order < #lastOrder or (#order == #lastOrder and order <= lastOrder) then
                        return previousStreamId
                    end
                end
            end
        end
    end
end
local streamId
if order then
    streamId = redis.call('XADD', KEYS[1], '*', 'event', ARGV[3], 'groupPublicationOrder', order)
else
    streamId = redis.call('XADD', KEYS[1], '*', 'event', ARGV[3])
end
historyBytes = historyBytes + #ARGV[3]
local count = redis.call('XLEN', KEYS[1])
local now = redis.call('TIME')
local cutoff = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) - options.historySeconds * 1000
local done = false
while count > 1 and not done do
    local oldest = redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', 1)
    if #oldest == 0 then break end
    local oldestMilliseconds = tonumber(string.match(oldest[1][1], '^(%d+)'))
    if count <= options.historyMaxLength and historyBytes <= options.historyMaxBytes and oldestMilliseconds >= cutoff then break end
    local entries = redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', 128)
    local removed = {}
    for _, entry in ipairs(entries) do
        local milliseconds = tonumber(string.match(entry[1], '^(%d+)'))
        if count > 1 and (count > options.historyMaxLength or historyBytes > options.historyMaxBytes or milliseconds < cutoff) then
            local fields = entry[2]
            for i = 1, #fields, 2 do
                if fields[i] == 'event' then historyBytes = historyBytes - #fields[i + 1] end
            end
            removed[#removed + 1] = entry[1]
            count = count - 1
        else
            done = true
            break
        end
    end
    if #removed > 0 then redis.call('XDEL', KEYS[1], unpack(removed)) end
end
redis.call('SET', KEYS[4], tostring(historyBytes), 'EX', options.idleTtlSeconds)
redis.call('EXPIRE', KEYS[1], options.idleTtlSeconds)
redis.call('EXPIRE', KEYS[2], options.idleTtlSeconds)
local envelope = cjson.encode({epoch=epoch, streamId=streamId, previousStreamId=previousStreamId, event=event})
redis.call('SPUBLISH', KEYS[3], envelope)
return streamId
