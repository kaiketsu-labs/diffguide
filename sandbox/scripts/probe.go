package main

import "fmt"

func attempts() int { return 5 }

func main() {
	fmt.Println("retry attempts:", attempts())
}
