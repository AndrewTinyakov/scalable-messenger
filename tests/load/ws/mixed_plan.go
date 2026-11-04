package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"os"
	"sort"
	"sync/atomic"
	"time"
)

const mixedMaxChats = 2000
const mixedMaxMemberships = 200000
const mixedMaxSubscriptions = 64

type mixedScenario struct {
	Seed                 int64          `json:"seed"`
	ActiveSenderFraction float64        `json:"activeSenderFraction"`
	Payloads             []mixedPayload `json:"payloads"`
	Groups               []mixedCohort  `json:"groups"`
}

type mixedPayload struct {
	Bytes  int `json:"bytes"`
	Weight int `json:"weight"`
}

type mixedCohort struct {
	Count             int     `json:"count"`
	Members           int     `json:"members"`
	MessagesPerSecond float64 `json:"messagesPerSecond"`
}

type mixedChat struct {
	id       string
	members  []int
	senders  []int
	rate     float64
	baseline uint64
	sent     atomic.Int64
}

type mixedWorkload struct {
	scenario             mixedScenario
	users                []session
	chats                []*mixedChat
	memberships          map[string][]*mixedChat
	schedule             []mixedSend
	activeUsers          int
	selectedActiveUsers  int
	offeredRate          float64
	offeredNotifications float64
	dispatched           atomic.Int64
	queueDropped         atomic.Int64
	lateDropped          atomic.Int64
	cancelled            atomic.Int64
	maxLag               atomic.Int64
	maxWriteWait         atomic.Int64
}

type mixedChatManifest struct {
	ID      string   `json:"id"`
	Members []string `json:"members"`
}

type chatProgress struct {
	chat       *mixedChat
	sequence   uint64
	epoch      string
	streamID   string
	subscribed bool
	delivered  atomic.Int64
}

func readMixedScenario(path string) (mixedScenario, error) {
	var scenario mixedScenario
	file, err := os.Open(path)
	if err != nil {
		return scenario, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return scenario, err
	}
	if info.Size() > 1<<20 {
		return scenario, errors.New("scenario exceeds 1 MiB")
	}
	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&scenario); err != nil {
		return scenario, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return scenario, errors.New("scenario must contain one JSON object")
	}
	return scenario, scenario.validate()
}

func (scenario mixedScenario) validate() error {
	if math.IsNaN(scenario.ActiveSenderFraction) || scenario.ActiveSenderFraction <= 0 || scenario.ActiveSenderFraction > 1 || len(scenario.Payloads) == 0 || len(scenario.Payloads) > 16 || len(scenario.Groups) == 0 || len(scenario.Groups) > 32 {
		return errors.New("scenario needs an active sender fraction in (0,1], 1-16 payload variants and 1-32 group cohorts")
	}
	weight := 0
	for _, payload := range scenario.Payloads {
		if payload.Bytes < 80 || payload.Bytes > 4000 || payload.Weight < 1 || payload.Weight > 100000 {
			return errors.New("scenario payloads need 80-4000 bytes and weights in 1-100000")
		}
		weight += payload.Weight
	}
	chats, memberships, rate := 0, 0, 0.0
	for _, cohort := range scenario.Groups {
		if cohort.Count < 1 || cohort.Count > mixedMaxChats || cohort.Members < 2 || cohort.Members > 1000 || math.IsNaN(cohort.MessagesPerSecond) || math.IsInf(cohort.MessagesPerSecond, 0) || cohort.MessagesPerSecond <= 0 || cohort.MessagesPerSecond > 1000 {
			return errors.New("scenario cohorts need 1-2000 groups, 2-1000 members and a finite rate in (0,1000] messages/s per group")
		}
		chats += cohort.Count
		memberships += cohort.Count * cohort.Members
		rate += float64(cohort.Count) * cohort.MessagesPerSecond
	}
	if chats > mixedMaxChats || memberships > mixedMaxMemberships || rate > 10000 || weight > 1000000 {
		return errors.New("scenario exceeds 2000 chats, 200000 memberships, 10000 messages/s or 1000000 payload weight")
	}
	return nil
}

func (mixed *mixedWorkload) plan(sessions []session, connections int, duration time.Duration, maxMessages int) error {
	if err := mixed.scenario.validate(); err != nil {
		return err
	}
	if len(sessions) == 0 || connections < 1 || connections > 50000 {
		return errors.New("mixed plan needs sessions and 1-50000 sockets")
	}
	seen := make(map[string]bool)
	socketCounts := make(map[string]int)
	for index := range connections {
		account := sessions[index%len(sessions)]
		socketCounts[account.UserID]++
		if !seen[account.UserID] {
			mixed.users = append(mixed.users, account)
			seen[account.UserID] = true
		}
	}
	if len(mixed.users) > 10000 {
		return errors.New("mixed scenario supports at most 10000 connected users")
	}
	rng := rand.New(rand.NewSource(mixed.scenario.Seed))
	activeOrder := rng.Perm(len(mixed.users))
	activeCount := max(1, int(math.Ceil(float64(len(mixed.users))*mixed.scenario.ActiveSenderFraction)))
	mixed.selectedActiveUsers = activeCount
	active := make(map[int]bool, activeCount)
	for _, user := range activeOrder[:activeCount] {
		active[user] = true
	}
	mixed.memberships = make(map[string][]*mixedChat, len(mixed.users))
	counts := make([]int, len(mixed.users))
	effective := make(map[int]bool)
	subscriptions := 0
	for _, cohort := range mixed.scenario.Groups {
		if cohort.Members > len(mixed.users) {
			return fmt.Errorf("%d-member group exceeds %d connected users", cohort.Members, len(mixed.users))
		}
		for range cohort.Count {
			members := append([]int(nil), rng.Perm(len(mixed.users))[:cohort.Members]...)
			hasSender := false
			for _, member := range members {
				hasSender = hasSender || active[member]
			}
			if !hasSender {
				members[0] = activeOrder[len(mixed.chats)%activeCount]
			}
			sort.Ints(members)
			chat := &mixedChat{members: members, rate: cohort.MessagesPerSecond}
			recipientSockets := 0
			for _, member := range members {
				mixed.memberships[mixed.users[member].UserID] = append(mixed.memberships[mixed.users[member].UserID], chat)
				counts[member]++
				if counts[member] > mixedMaxSubscriptions {
					return errors.New("scenario exceeds 64 subscriptions per user")
				}
				recipientSockets += socketCounts[mixed.users[member].UserID]
				if active[member] {
					chat.senders = append(chat.senders, member)
					effective[member] = true
				}
			}
			subscriptions += recipientSockets
			if subscriptions > mixedMaxMemberships {
				return errors.New("scenario exceeds 200000 socket subscriptions")
			}
			mixed.chats = append(mixed.chats, chat)
			mixed.offeredRate += chat.rate
			mixed.offeredNotifications += chat.rate * float64(recipientSockets)
		}
	}
	mixed.activeUsers = len(effective)
	var err error
	mixed.schedule, err = mixed.buildSchedule(duration, maxMessages)
	return err
}
