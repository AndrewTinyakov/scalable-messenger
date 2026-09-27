package com.andrewtinyakov.messenger.shared.integration

class DependencyUnavailableException(
    val dependency: String,
    cause: Throwable,
) : RuntimeException(
        "Dependency unavailable: $dependency",
        cause,
    )
