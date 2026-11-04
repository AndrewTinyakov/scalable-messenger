package messagecodec

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"strings"
	"sync"
	"unicode/utf8"
)

func Encode(value any) ([]byte, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode JSON: %w", err)
	}
	return payload, nil
}

func Decode[T any](payload []byte) (T, error) { return decode[T](payload, nil) }

func DecodeObject[T any](payload []byte) (T, Fields, error) {
	var fields Fields
	value, err := decode[T](payload, &fields)
	return value, fields, err
}

func decode[T any](payload []byte, fields *Fields) (T, error) {
	var value T
	if !utf8.Valid(payload) {
		return value, fmt.Errorf("decode JSON: invalid UTF-8")
	}
	shape := json.NewDecoder(bytes.NewReader(payload))
	shape.UseNumber()
	if err := validateValueFields(shape, reflect.TypeFor[T](), fields); err != nil {
		return value, fmt.Errorf("decode JSON: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return value, fmt.Errorf("decode JSON: %w", err)
	}

	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return value, fmt.Errorf("decode JSON: multiple values")
		}
		return value, fmt.Errorf("decode trailing JSON: %w", err)
	}
	return value, nil
}

func validateValue(decoder *json.Decoder, expected reflect.Type) error {
	return validateValueFields(decoder, expected, nil)
}

func validateValueFields(decoder *json.Decoder, expected reflect.Type, capture *Fields) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if token == nil {
		return fmt.Errorf("null value")
	}
	for expected != nil && expected.Kind() == reflect.Pointer {
		expected = expected.Elem()
	}
	if expected == reflect.TypeFor[json.RawMessage]() {
		expected = nil
	}
	switch token {
	case json.Delim('{'):
		var fields map[string]jsonField
		if expected != nil && expected.Kind() == reflect.Struct {
			fields = structFields(expected)
		}
		var seenBits uint64
		var seen map[string]bool
		if fields == nil || len(fields) > 64 {
			seen = make(map[string]bool)
		}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return err
			}
			name, ok := key.(string)
			if !ok {
				return fmt.Errorf("invalid object field %q", key)
			}
			field, known := fields[name]
			if fields != nil && !known {
				return fmt.Errorf("unknown field %q", name)
			}
			if seen != nil {
				if seen[name] {
					return fmt.Errorf("duplicate object field %q", name)
				}
				seen[name] = true
			} else {
				bit := uint64(1) << field.index
				if seenBits&bit != 0 {
					return fmt.Errorf("duplicate object field %q", name)
				}
				seenBits |= bit
			}
			fieldType := field.kind
			if err := validateValue(decoder, fieldType); err != nil {
				return err
			}
		}
		if capture != nil {
			*capture = Fields{schema: fields, bits: seenBits, names: seen}
		}
	case json.Delim('['):
		var itemType reflect.Type
		if expected != nil && (expected.Kind() == reflect.Array || expected.Kind() == reflect.Slice) {
			itemType = expected.Elem()
		}
		for decoder.More() {
			if err := validateValue(decoder, itemType); err != nil {
				return err
			}
		}
	default:
		return nil
	}
	_, err = decoder.Token()
	return err
}

var jsonSchemas sync.Map

type jsonField struct {
	kind  reflect.Type
	index int
}

func structFields(kind reflect.Type) map[string]jsonField {
	if cached, exists := jsonSchemas.Load(kind); exists {
		return cached.(map[string]jsonField)
	}
	fields := make(map[string]jsonField, kind.NumField())
	for index := range kind.NumField() {
		field := kind.Field(index)
		if !field.IsExported() {
			continue
		}
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name == "-" {
			continue
		}
		if name == "" {
			name = field.Name
		}
		fields[name] = jsonField{kind: field.Type, index: len(fields)}
	}
	cached, _ := jsonSchemas.LoadOrStore(kind, fields)
	return cached.(map[string]jsonField)
}
