package messagecodec

type Fields struct {
	schema map[string]jsonField
	bits   uint64
	names  map[string]bool
}

func (fields Fields) Has(name string) bool {
	if fields.names != nil {
		return fields.names[name]
	}
	field, exists := fields.schema[name]
	return exists && fields.bits&(uint64(1)<<field.index) != 0
}

func (fields Fields) Match(required, optional []string) bool {
	var allowed uint64
	for _, name := range required {
		if !fields.Has(name) {
			return false
		}
		allowed |= uint64(1) << fields.schema[name].index
	}
	for _, name := range optional {
		if field, exists := fields.schema[name]; exists {
			allowed |= uint64(1) << field.index
		}
	}
	if fields.names != nil {
		for name := range fields.names {
			accepted := false
			for _, candidate := range required {
				if name == candidate {
					accepted = true
					break
				}
			}
			if !accepted {
				for _, candidate := range optional {
					if name == candidate {
						accepted = true
						break
					}
				}
			}
			if !accepted {
				return false
			}
		}
		return true
	}
	return fields.bits & ^allowed == 0
}
